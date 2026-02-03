/**
 * SHARPS EDGE - Conflict Detection Engine
 *
 * Runs six pre-action checks before every modifying tool call.
 * Can block actions that violate project charter or guardrails.
 *
 * Phase 2 hardening:
 * - Parses CHARTER.md to extract scope IN/OUT and guardrails
 * - Validates file paths against charter scope
 * - Tracks active work via lock file to detect contention
 * - Detects API quota violations in shell commands
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { AuditLogger } from "./audit-logger.js";
import {
  type ConflictResult,
  MODIFYING_TOOLS,
  Severity,
  type SharpsEdgeConfig,
} from "./types.js";

// ============================================================================
// Charter Parsing
// ============================================================================

type ParsedCharter = {
  scopeIn: string[];
  scopeOut: string[];
  guardrails: string[];
};

/** Cache parsed charter to avoid re-reading on every tool call. */
let charterCache: { path: string; mtime: number; parsed: ParsedCharter } | null = null;

/**
 * Parse a CHARTER.md file to extract scope and guardrails.
 * Looks for "## Scope IN", "## Scope OUT", "## Guardrails" sections
 * and extracts bullet items from each.
 */
function parseCharter(content: string): ParsedCharter {
  const extractBullets = (section: string): string[] => {
    const match = content.match(new RegExp(`## ${section}[\\s\\S]*?(?=\\n## |$)`, "i"));
    if (!match) return [];
    return match[0]
      .split("\n")
      .filter((line) => /^[-*]\s/.test(line.trim()) || /^\d+\.\s/.test(line.trim()))
      .map((line) => line.replace(/^[-*\d.]+\s+/, "").replace(/^[^\w]*/, "").trim())
      .filter(Boolean);
  };

  return {
    scopeIn: extractBullets("Scope IN"),
    scopeOut: extractBullets("Scope OUT"),
    guardrails: extractBullets("Guardrails"),
  };
}

async function loadCharter(workspaceDir: string, projectDir: string): Promise<ParsedCharter> {
  const charterPath = path.join(workspaceDir, projectDir, "CHARTER.md");

  try {
    const stat = await fs.stat(charterPath);
    const mtime = stat.mtimeMs;

    // Return cached if file hasn't changed
    if (charterCache && charterCache.path === charterPath && charterCache.mtime === mtime) {
      return charterCache.parsed;
    }

    const content = await fs.readFile(charterPath, "utf-8");
    const parsed = parseCharter(content);
    charterCache = { path: charterPath, mtime, parsed };
    return parsed;
  } catch {
    return { scopeIn: [], scopeOut: [], guardrails: [] };
  }
}

// ============================================================================
// Contention Tracking
// ============================================================================

const LOCK_FILE = ".sharps-edge-active.json";

type ActiveWork = {
  toolName: string;
  filePath: string | null;
  startedAt: string;
};

async function readActiveLock(workspaceDir: string): Promise<ActiveWork | null> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, LOCK_FILE), "utf-8");
    return JSON.parse(raw) as ActiveWork;
  } catch {
    return null;
  }
}

async function writeActiveLock(workspaceDir: string, work: ActiveWork | null): Promise<void> {
  const lockPath = path.join(workspaceDir, LOCK_FILE);
  if (work === null) {
    try { await fs.unlink(lockPath); } catch { /* already gone */ }
  } else {
    await fs.writeFile(lockPath, JSON.stringify(work), "utf-8");
  }
}

// ============================================================================
// Check Context
// ============================================================================

type CheckContext = {
  toolName: string;
  params: Record<string, unknown>;
  workspaceDir: string;
  projectDir: string;
  cfg: SharpsEdgeConfig;
  budgetRatio: () => Promise<number>;
  charter: ParsedCharter;
};

type ConflictCheck = {
  name: string;
  check: (ctx: CheckContext) => Promise<ConflictResult>;
};

// ============================================================================
// The Six Checks
// ============================================================================

/**
 * Check 1: Scope - Validates against parsed charter scope IN/OUT.
 */
async function checkScope(ctx: CheckContext): Promise<ConflictResult> {
  const filePath = extractFilePath(ctx.params);
  if (!filePath) return { status: "PASS" };

  const absWorkspace = path.resolve(ctx.workspaceDir);
  const absTarget = path.resolve(filePath);

  // Block operations entirely outside the workspace, /tmp, or the repo
  const repoRoot = path.resolve(ctx.workspaceDir, "..", "..");
  if (
    !absTarget.startsWith(absWorkspace + "/") && absTarget !== absWorkspace &&
    !absTarget.startsWith("/tmp/") && absTarget !== "/tmp" &&
    !absTarget.startsWith(repoRoot + "/") && absTarget !== repoRoot
  ) {
    return {
      status: "BLOCK",
      check: "scope",
      reason: `File "${filePath}" is outside workspace and repo boundaries`,
    };
  }

  // Check charter scope OUT keywords against the file path and command
  const command = typeof ctx.params.command === "string" ? ctx.params.command : "";
  const combined = `${filePath} ${command}`.toLowerCase();

  for (const excluded of ctx.charter.scopeOut) {
    const keyword = excluded.toLowerCase();
    // Match if the scope OUT item appears as a meaningful substring
    if (keyword.length > 3 && combined.includes(keyword)) {
      return {
        status: "BLOCK",
        check: "scope",
        reason: `Action matches Scope OUT item: "${excluded}"`,
      };
    }
  }

  return { status: "PASS" };
}

/**
 * Check 2: Resources - Budget and API quota validation.
 */
async function checkResources(ctx: CheckContext): Promise<ConflictResult> {
  const ratio = await ctx.budgetRatio();

  if (ratio >= 1.0) {
    return {
      status: "REJECT",
      check: "resources",
      reason: `Monthly budget exhausted (${(ratio * 100).toFixed(1)}% used). All actions blocked.`,
    };
  }

  if (ratio >= 0.95 && isExpensiveOperation(ctx.toolName)) {
    return {
      status: "BLOCK",
      check: "resources",
      reason: `Budget at ${(ratio * 100).toFixed(1)}%. Blocking expensive operation "${ctx.toolName}".`,
    };
  }

  // Check for API quota usage in shell commands
  const command = typeof ctx.params.command === "string" ? ctx.params.command : "";
  if (/the-odds-api\.com|odds-api/i.test(command)) {
    // The agent should be using cached calls - warn if raw curl detected
    return {
      status: "BLOCK",
      check: "resources",
      reason: "Direct Odds API call detected. Use the caching layer to stay within 500 calls/month.",
    };
  }

  return { status: "PASS" };
}

/**
 * Check 3: Contention - Detect conflicting work via lock file.
 */
async function checkContention(ctx: CheckContext): Promise<ConflictResult> {
  const active = await readActiveLock(ctx.workspaceDir);
  if (!active) return { status: "PASS" };

  const currentFile = extractFilePath(ctx.params);
  if (!currentFile || !active.filePath) return { status: "PASS" };

  // Check if targeting the same file as active work
  const absActive = path.resolve(active.filePath);
  const absCurrent = path.resolve(currentFile);

  if (absActive === absCurrent) {
    const startedAt = new Date(active.startedAt);
    const elapsed = Date.now() - startedAt.getTime();

    // If the lock is stale (>5 minutes), clear it
    if (elapsed > 5 * 60 * 1000) {
      await writeActiveLock(ctx.workspaceDir, null);
      return { status: "PASS" };
    }

    return {
      status: "BLOCK",
      check: "contention",
      reason: `File "${currentFile}" is being modified by active task "${active.toolName}" (started ${Math.round(elapsed / 1000)}s ago)`,
    };
  }

  return { status: "PASS" };
}

/**
 * Check 4: Authority - Block actions requiring human approval.
 */
async function checkAuthority(ctx: CheckContext): Promise<ConflictResult> {
  const command = typeof ctx.params.command === "string" ? ctx.params.command : "";

  // Deployment commands
  const deployPatterns = [
    { pattern: /wrangler\s+(deploy|publish)/i, desc: "Cloudflare deployment" },
    { pattern: /npm\s+publish/i, desc: "npm publish" },
    { pattern: /fly\s+(deploy|scale)/i, desc: "Fly.io deployment" },
    { pattern: /docker\s+push/i, desc: "Docker push" },
    { pattern: /terraform\s+apply/i, desc: "Terraform apply" },
  ];

  for (const { pattern, desc } of deployPatterns) {
    if (pattern.test(command)) {
      return {
        status: "BLOCK",
        check: "authority",
        reason: `${desc} requires Michael's approval: "${command.slice(0, 100)}"`,
      };
    }
  }

  // Money-spending commands
  const spendPatterns = [
    { pattern: /stripe\s/i, desc: "Stripe operation" },
    { pattern: /payment/i, desc: "Payment operation" },
    { pattern: /curl.*api.*key/i, desc: "Authenticated API call" },
  ];

  for (const { pattern, desc } of spendPatterns) {
    if (pattern.test(command)) {
      return {
        status: "BLOCK",
        check: "authority",
        reason: `${desc} requires approval: "${command.slice(0, 100)}"`,
      };
    }
  }

  return { status: "PASS" };
}

/**
 * Check 5: Safety - Block dangerous or irreversible operations.
 */
async function checkSafety(ctx: CheckContext): Promise<ConflictResult> {
  const command = typeof ctx.params.command === "string" ? ctx.params.command : "";

  // Destructive commands -> CRITICAL
  const criticalPatterns = [
    { pattern: /rm\s+-rf\s+[\/~]/, desc: "Recursive delete from root/home" },
    { pattern: /DROP\s+(?:TABLE|DATABASE)/i, desc: "Database drop" },
    { pattern: /TRUNCATE\s+TABLE/i, desc: "Table truncation" },
    { pattern: />\s*\/dev\/sd[a-z]/, desc: "Write to block device" },
    { pattern: /mkfs\./, desc: "Filesystem format" },
    { pattern: /dd\s+if=/, desc: "Raw disk write" },
    { pattern: /chmod\s+-R\s+777/, desc: "Recursive world-writable permissions" },
    { pattern: /:(){ :\|:& };:/, desc: "Fork bomb" },
  ];

  for (const { pattern, desc } of criticalPatterns) {
    if (pattern.test(command)) {
      return {
        status: "CRITICAL",
        check: "safety",
        reason: `Dangerous: ${desc} — "${command.slice(0, 80)}"`,
      };
    }
  }

  // Secrets exposure -> BLOCK
  const filePath = extractFilePath(ctx.params);
  if (filePath) {
    const secretPatterns = [
      { pattern: /\.env(?:\.|$)/, desc: "Environment file" },
      { pattern: /credentials\.json/, desc: "Credentials file" },
      { pattern: /private[_-]?key/i, desc: "Private key file" },
      { pattern: /\.pem$/, desc: "PEM certificate" },
      { pattern: /id_rsa/, desc: "SSH private key" },
      { pattern: /\.secret/, desc: "Secret file" },
      { pattern: /token\.json/, desc: "Token file" },
    ];

    for (const { pattern, desc } of secretPatterns) {
      if (pattern.test(filePath)) {
        return {
          status: "BLOCK",
          check: "safety",
          reason: `Operation on ${desc}: "${filePath}"`,
        };
      }
    }
  }

  // Network exfiltration patterns -> BLOCK
  const exfilPatterns = [
    { pattern: /curl.*-d.*<\(cat/, desc: "Data exfiltration via curl" },
    { pattern: /nc\s+-[le]/, desc: "Netcat listener" },
    { pattern: /wget.*\|.*sh/, desc: "Remote code execution" },
    { pattern: /curl.*\|.*sh/, desc: "Remote code execution" },
  ];

  for (const { pattern, desc } of exfilPatterns) {
    if (pattern.test(command)) {
      return {
        status: "CRITICAL",
        check: "safety",
        reason: `${desc}: "${command.slice(0, 80)}"`,
      };
    }
  }

  return { status: "PASS" };
}

/**
 * Check 6: Charter Guardrails - Validates against parsed guardrails.
 */
async function checkCharter(ctx: CheckContext): Promise<ConflictResult> {
  const command = typeof ctx.params.command === "string" ? ctx.params.command : "";
  const filePath = extractFilePath(ctx.params) ?? "";
  const combined = `${command} ${filePath}`.toLowerCase();

  // Check each guardrail from the charter
  for (const guardrail of ctx.charter.guardrails) {
    const lower = guardrail.toLowerCase();

    // "Stay within free tiers" - block paid API signups
    if (lower.includes("free tier") && /upgrade|billing|subscribe|paid\s+plan/i.test(combined)) {
      return {
        status: "REJECT",
        check: "charter",
        reason: `Guardrail violation: "${guardrail}" — action involves paid tier upgrade`,
      };
    }

    // "Cache aggressively" - warn on uncached API calls
    if (lower.includes("cache") && /curl.*api\.|fetch.*api\./i.test(command)) {
      // Informational warning, not blocking - the agent should self-correct
    }

    // "Never guarantee outcomes" - this is enforced at the prompt level, not here
    // "Track all costs" - this is handled by cost-tracker
  }

  // Block operations that would modify charter or master project without approval
  if (filePath) {
    const protectedFiles = ["CHARTER.md", "MASTER_PROJECT.md", "CONFLICT_DETECTION.md"];
    const basename = path.basename(filePath);
    if (protectedFiles.includes(basename)) {
      return {
        status: "BLOCK",
        check: "charter",
        reason: `Protected governance file "${basename}" cannot be modified without approval`,
      };
    }
  }

  return { status: "PASS" };
}

// ============================================================================
// Infrastructure
// ============================================================================

const CONFLICT_CHECKS: ConflictCheck[] = [
  { name: "scope", check: checkScope },
  { name: "resources", check: checkResources },
  { name: "contention", check: checkContention },
  { name: "authority", check: checkAuthority },
  { name: "safety", check: checkSafety },
  { name: "charter", check: checkCharter },
];

function extractFilePath(params: Record<string, unknown>): string | null {
  return (
    (typeof params.path === "string" ? params.path : null) ??
    (typeof params.file_path === "string" ? params.file_path : null) ??
    (typeof params.filename === "string" ? params.filename : null) ??
    (typeof params.target === "string" ? params.target : null) ??
    null
  );
}

function isExpensiveOperation(toolName: string): boolean {
  const expensive = new Set(["exec", "shell", "bash", "run_command", "browser", "web_search"]);
  return expensive.has(toolName);
}

// ============================================================================
// Registration
// ============================================================================

export function registerConflictDetector(
  api: OpenClawPluginApi,
  cfg: SharpsEdgeConfig,
  auditLogger: AuditLogger,
  getBudgetRatio: () => Promise<number>,
): void {
  if (cfg.conflictDetection?.enabled === false) {
    api.logger.info?.("sharps-edge: Conflict detection disabled");
    return;
  }

  const strictMode = cfg.conflictDetection?.strictMode ?? false;
  const projectDir = cfg.projectDir ?? "projects/SHARPS-EDGE";

  api.on(
    "before_tool_call",
    async (event, ctx) => {
      // Only check modifying tools
      if (!MODIFYING_TOOLS.has(event.toolName)) {
        return;
      }

      const workspaceDir = ctx.workspaceDir ?? api.resolvePath("~/.openclaw/workspace");

      // Parse charter for scope validation
      const charter = await loadCharter(workspaceDir, projectDir);

      const checkCtx: CheckContext = {
        toolName: event.toolName,
        params: event.params,
        workspaceDir,
        projectDir,
        cfg,
        budgetRatio: getBudgetRatio,
        charter,
      };

      const filePath = extractFilePath(event.params);

      // Run all six checks
      for (const { name, check } of CONFLICT_CHECKS) {
        try {
          const result = await check(checkCtx);

          if (result.status !== "PASS") {
            const projectId = projectDir.split("/").pop() ?? "UNKNOWN";
            await auditLogger.logConflict(
              projectId,
              `${event.toolName}: ${JSON.stringify(event.params).slice(0, 200)}`,
              name,
              result.reason,
              result.status === "CRITICAL"
                ? Severity.CRITICAL
                : result.status === "REJECT"
                  ? Severity.REJECT
                  : Severity.BLOCK,
            );

            // In strict mode, block on any failure. Otherwise only CRITICAL and REJECT.
            if (strictMode || result.status === "CRITICAL" || result.status === "REJECT") {
              api.logger.warn(`sharps-edge: ${result.status} [${name}] ${result.reason}`);
              return {
                block: true,
                blockReason: `[SHARPS EDGE ${result.status}] Check "${name}" failed: ${result.reason}`,
              };
            }

            api.logger.warn(`sharps-edge: WARN [${name}] ${result.reason} (non-strict, allowing)`);
          }
        } catch (err) {
          api.logger.warn(`sharps-edge: Check "${name}" error: ${String(err)}`);
        }
      }

      // All checks passed — write active lock for contention detection
      await writeActiveLock(workspaceDir, {
        toolName: event.toolName,
        filePath,
        startedAt: new Date().toISOString(),
      });
      return;
    },
    { priority: 10 },
  );

  // Clear contention lock after tool completes
  api.on("after_tool_call", async (_event, ctx) => {
    const workspaceDir = ctx.workspaceDir ?? api.resolvePath("~/.openclaw/workspace");
    await writeActiveLock(workspaceDir, null);
  });
}
