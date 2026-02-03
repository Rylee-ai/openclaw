/**
 * SHARPS EDGE - Cost Tracking System
 *
 * Monitors budget usage and blocks actions when limits are approached.
 * Phase 2: API quota tracking, command-level cost estimation, daily burn alerts.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { AuditLogger } from "./audit-logger.js";
import {
  type BudgetState,
  DEFAULT_BUDGET_ALERT_THRESHOLD,
  DEFAULT_BUDGET_MONTHLY_USD,
  Severity,
  type SharpsEdgeConfig,
} from "./types.js";

// ============================================================================
// Cost Estimation
// ============================================================================

/**
 * Estimate cost of a tool call in USD.
 * Granular estimates based on tool type and params.
 */
function estimateToolCost(toolName: string, params: Record<string, unknown>): number {
  const command = typeof params.command === "string" ? params.command : "";

  // Shell commands - estimate by what they're doing
  if (toolName === "exec" || toolName === "shell" || toolName === "bash" || toolName === "run_command") {
    // API calls are more expensive (network + potential metered API)
    if (/curl|wget|fetch|http/i.test(command)) return 0.01;
    // Build/test commands use compute
    if (/build|test|compile|bundle/i.test(command)) return 0.005;
    // Deployment commands
    if (/deploy|publish|push/i.test(command)) return 0.02;
    // Simple commands (ls, cat, git status)
    return 0.002;
  }

  // Browser operations are moderate (headless browser + potential API)
  if (toolName === "browser") return 0.015;
  if (toolName === "web_search") return 0.01;

  // File operations are essentially free
  const fileOps = new Set(["read", "write", "edit", "apply_patch", "create_file", "delete_file", "move_file"]);
  if (fileOps.has(toolName)) return 0.0001;

  // Default
  return 0.001;
}

/**
 * Detect API-specific usage from tool params and return quota key if applicable.
 */
function detectApiUsage(toolName: string, params: Record<string, unknown>): string | null {
  const command = typeof params.command === "string" ? params.command : "";

  if (/the-odds-api\.com|odds-api/i.test(command)) return "the-odds-api";
  if (/api\.espn\.com|espn/i.test(command)) return "espn";
  if (/open-meteo\.com/i.test(command)) return "open-meteo";

  return null;
}

// ============================================================================
// CostTracker Class
// ============================================================================

export class CostTracker {
  private workspaceDir: string;
  private monthlyLimitUsd: number;
  private alertThreshold: number;
  private state: BudgetState | null = null;
  private dirty = false;
  private lastAlertRatio = 0; // Prevent alert spam

  constructor(workspaceDir: string, monthlyLimitUsd: number, alertThreshold: number) {
    this.workspaceDir = workspaceDir;
    this.monthlyLimitUsd = monthlyLimitUsd;
    this.alertThreshold = alertThreshold;
  }

  private get currentMonth(): string {
    return new Date().toISOString().slice(0, 7); // YYYY-MM
  }

  private get costFilePath(): string {
    return path.join(this.workspaceDir, "logs", "costs", `${this.currentMonth}.json`);
  }

  async loadState(): Promise<BudgetState> {
    if (this.state && this.state.month === this.currentMonth) {
      return this.state;
    }

    try {
      const raw = await fs.readFile(this.costFilePath, "utf-8");
      this.state = JSON.parse(raw) as BudgetState;

      if (this.state.month !== this.currentMonth) {
        this.state = this.freshState();
      }
    } catch {
      this.state = this.freshState();
    }

    return this.state;
  }

  private freshState(): BudgetState {
    return {
      month: this.currentMonth,
      totalSpentUsd: 0,
      entries: [],
      apiQuotas: {
        "the-odds-api": { limit: 500, used: 0, resetsAt: "monthly" },
        "espn": { limit: 10000, used: 0, resetsAt: "daily" },
        "open-meteo": { limit: 10000, used: 0, resetsAt: "daily" },
      },
    };
  }

  async saveState(): Promise<void> {
    if (!this.state || !this.dirty) return;

    const dir = path.dirname(this.costFilePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.costFilePath, JSON.stringify(this.state, null, 2), "utf-8");
    this.dirty = false;
  }

  async recordCost(
    toolName: string,
    params: Record<string, unknown>,
    projectId: string,
  ): Promise<{ ratio: number; quotaWarning: string | null }> {
    const state = await this.loadState();
    const cost = estimateToolCost(toolName, params);

    state.totalSpentUsd += cost;
    state.entries.push({
      timestamp: new Date().toISOString(),
      projectId,
      toolName,
      estimatedCostUsd: cost,
      cumulativeMonthUsd: state.totalSpentUsd,
    });

    // Track API quota usage
    let quotaWarning: string | null = null;
    const apiKey = detectApiUsage(toolName, params);
    if (apiKey && state.apiQuotas[apiKey]) {
      const quota = state.apiQuotas[apiKey];
      quota.used++;

      const remaining = quota.limit - quota.used;
      if (remaining <= 0) {
        quotaWarning = `API quota exhausted for ${apiKey} (${quota.used}/${quota.limit})`;
      } else if (remaining <= quota.limit * 0.1) {
        quotaWarning = `API quota low for ${apiKey}: ${remaining} remaining of ${quota.limit}`;
      }
    }

    // Keep entries bounded
    if (state.entries.length > 1000) {
      state.entries = state.entries.slice(-500);
    }

    this.dirty = true;

    // Save periodically
    if (state.entries.length % 10 === 0) {
      await this.saveState();
    }

    const ratio = state.totalSpentUsd / this.monthlyLimitUsd;
    return { ratio, quotaWarning };
  }

  async getBudgetRatio(): Promise<number> {
    const state = await this.loadState();
    return state.totalSpentUsd / this.monthlyLimitUsd;
  }

  /**
   * Track a direct API call from a tool (not a shell command).
   * Increments the quota counter for the given API key and returns remaining quota.
   */
  async trackApiCall(apiKey: string): Promise<{ remaining: number; warning: string | null }> {
    const state = await this.loadState();
    const quota = state.apiQuotas[apiKey];
    if (!quota) {
      return { remaining: Infinity, warning: null };
    }

    quota.used++;
    this.dirty = true;

    const remaining = quota.limit - quota.used;
    let warning: string | null = null;
    if (remaining <= 0) {
      warning = `API quota exhausted for ${apiKey} (${quota.used}/${quota.limit})`;
    } else if (remaining <= quota.limit * 0.1) {
      warning = `API quota low for ${apiKey}: ${remaining} remaining of ${quota.limit}`;
    }

    // Auto-save when quota is low
    if (warning) {
      await this.saveState();
    }

    return { remaining, warning };
  }

  async getSummary(): Promise<{
    month: string;
    spent: number;
    limit: number;
    ratio: number;
    remaining: number;
    dailyBurn: number;
    daysRemaining: number;
    projectedMonthEnd: number;
    apiQuotas: BudgetState["apiQuotas"];
  }> {
    const state = await this.loadState();
    const dayOfMonth = new Date().getDate();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const ratio = state.totalSpentUsd / this.monthlyLimitUsd;
    const dailyBurn = dayOfMonth > 0 ? state.totalSpentUsd / dayOfMonth : 0;
    const daysRemaining = daysInMonth - dayOfMonth;
    const projectedMonthEnd = state.totalSpentUsd + dailyBurn * daysRemaining;

    return {
      month: state.month,
      spent: state.totalSpentUsd,
      limit: this.monthlyLimitUsd,
      ratio,
      remaining: this.monthlyLimitUsd - state.totalSpentUsd,
      dailyBurn,
      daysRemaining,
      projectedMonthEnd,
      apiQuotas: state.apiQuotas,
    };
  }
}

// ============================================================================
// Registration
// ============================================================================

export function registerCostTracker(
  api: OpenClawPluginApi,
  cfg: SharpsEdgeConfig,
  auditLogger: AuditLogger,
): CostTracker {
  const workspaceDir = api.resolvePath("~/.openclaw/workspace");
  const monthlyLimit = cfg.budgetMonthlyUsd ?? DEFAULT_BUDGET_MONTHLY_USD;
  const alertThreshold = cfg.budgetAlertThreshold ?? DEFAULT_BUDGET_ALERT_THRESHOLD;

  const tracker = new CostTracker(workspaceDir, monthlyLimit, alertThreshold);

  // Track costs after every tool call
  api.on("after_tool_call", async (event, ctx) => {
    const projectId = ctx.agentId ?? "UNKNOWN";
    try {
      const { ratio, quotaWarning } = await tracker.recordCost(event.toolName, event.params, projectId);

      // Budget threshold alerts (alert at each 10% step: 80%, 90%, 95%)
      const thresholds = [alertThreshold, 0.9, 0.95];
      for (const t of thresholds) {
        if (ratio >= t && ratio < t + 0.005) {
          const summary = await tracker.getSummary();
          const msg = `Budget at ${(ratio * 100).toFixed(1)}% ($${summary.spent.toFixed(2)} / $${summary.limit}). Projected month-end: $${summary.projectedMonthEnd.toFixed(2)}`;
          await auditLogger.logAlert(projectId, Severity.WARN, msg);
          api.logger.warn(`sharps-edge: ${msg}`);
        }
      }

      // API quota warnings
      if (quotaWarning) {
        await auditLogger.logAlert(projectId, Severity.WARN, quotaWarning);
        api.logger.warn(`sharps-edge: ${quotaWarning}`);
      }
    } catch {
      // Never let cost tracking crash the pipeline
    }
  });

  // Persist on gateway stop
  api.on("gateway_stop", async () => {
    try {
      await tracker.saveState();
    } catch { /* best effort */ }
  });

  // Persist on session end
  api.on("session_end", async () => {
    try {
      await tracker.saveState();
    } catch { /* best effort */ }
  });

  return tracker;
}
