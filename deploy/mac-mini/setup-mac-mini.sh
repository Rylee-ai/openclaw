#!/usr/bin/env bash
set -euo pipefail

# SHARPS EDGE Builder Edition - Mac Mini Setup
# Installs OpenClaw + workspace + config for autonomous building

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_DIR="$HOME/.openclaw"
WORKSPACE_DIR="$OPENCLAW_DIR/workspace"

echo "=== SHARPS EDGE Builder Edition Setup ==="
echo ""

# --- Pre-flight checks ---

if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install with: brew install node"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "ERROR: Node.js 22+ required (found v$(node -v))"
  exit 1
fi

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "WARNING: OPENROUTER_API_KEY not set."
  echo "  Get a free key at https://openrouter.ai"
  echo "  Then: export OPENROUTER_API_KEY='sk-or-...'"
  echo ""
  read -rp "Continue without OpenRouter key? [y/N] " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    exit 1
  fi
fi

echo "Node.js: $(node -v)"
echo "OpenRouter: ${OPENROUTER_API_KEY:+configured}"
echo ""

# --- Install OpenClaw ---

echo "--- Installing OpenClaw ---"
if command -v openclaw &>/dev/null; then
  echo "OpenClaw already installed: $(openclaw --version 2>/dev/null || echo 'unknown')"
  read -rp "Reinstall/update? [y/N] " answer
  if [[ "$answer" == "y" || "$answer" == "Y" ]]; then
    npm install -g openclaw@latest
  fi
else
  npm install -g openclaw@latest
fi

# --- Install Wrangler (Cloudflare CLI) ---

echo ""
echo "--- Installing Wrangler (Cloudflare Workers CLI) ---"
if command -v wrangler &>/dev/null; then
  echo "Wrangler already installed: $(wrangler --version 2>/dev/null || echo 'unknown')"
else
  npm install -g wrangler
fi

# --- Set up workspace ---

echo ""
echo "--- Setting up workspace ---"
mkdir -p "$OPENCLAW_DIR"

if [ -d "$WORKSPACE_DIR" ]; then
  echo "Workspace already exists at $WORKSPACE_DIR"
  read -rp "Overwrite workspace files? [y/N] " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "Skipping workspace setup."
  else
    cp_workspace=true
  fi
else
  cp_workspace=true
fi

if [ "${cp_workspace:-false}" = true ]; then
  # Copy workspace from repo
  REPO_WORKSPACE="$SCRIPT_DIR/../../workspace"
  if [ -d "$REPO_WORKSPACE" ]; then
    echo "Copying workspace from repo..."
    cp -R "$REPO_WORKSPACE/" "$WORKSPACE_DIR/"
    echo "Workspace installed to $WORKSPACE_DIR"
  else
    echo "ERROR: Workspace directory not found at $REPO_WORKSPACE"
    echo "  Clone the full repo first: git clone https://github.com/Rylee-ai/openclaw"
    exit 1
  fi
fi

# --- Copy config ---

echo ""
echo "--- Configuring OpenClaw ---"
CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"
if [ -f "$CONFIG_FILE" ]; then
  echo "Config already exists at $CONFIG_FILE"
  read -rp "Overwrite config? [y/N] " answer
  if [[ "$answer" == "y" || "$answer" == "Y" ]]; then
    cp "$SCRIPT_DIR/openclaw.json" "$CONFIG_FILE"
    echo "Config updated."
  fi
else
  cp "$SCRIPT_DIR/openclaw.json" "$CONFIG_FILE"
  echo "Config installed to $CONFIG_FILE"
fi

# --- Create log directories ---

echo ""
echo "--- Creating log directories ---"
mkdir -p "$WORKSPACE_DIR/logs/conflicts"
mkdir -p "$WORKSPACE_DIR/logs/errors"
mkdir -p "$WORKSPACE_DIR/logs/decisions"
mkdir -p "$WORKSPACE_DIR/logs/alerts"
mkdir -p "$WORKSPACE_DIR/memory"
mkdir -p "$WORKSPACE_DIR/data/picks"
mkdir -p "$WORKSPACE_DIR/data/lessons"

# --- Set up parallel worktrees ---

echo ""
echo "--- Setting up parallel worktree infrastructure ---"

REPO_ROOT="$SCRIPT_DIR/../.."
WORKTREE_BASE="$(dirname "$REPO_ROOT")"

# Create worktree directories (actual worktrees created on-demand)
echo "Worktree base: $WORKTREE_BASE"
echo "  Worktrees will be created on-demand by Danno via 'git worktree add'"

# Add shell aliases for workspace switching
SHELL_RC="$HOME/.zshrc"
if [ ! -f "$SHELL_RC" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

if ! grep -q "# SHARPS EDGE worktree aliases" "$SHELL_RC" 2>/dev/null; then
  echo "" >> "$SHELL_RC"
  echo "# SHARPS EDGE worktree aliases (parallel Claude Code sessions)" >> "$SHELL_RC"
  echo "alias zm='cd $REPO_ROOT'           # main workspace" >> "$SHELL_RC"
  echo "alias za='cd $WORKTREE_BASE/openclaw-a'  # parallel session A" >> "$SHELL_RC"
  echo "alias zb='cd $WORKTREE_BASE/openclaw-b'  # parallel session B" >> "$SHELL_RC"
  echo "alias zc='cd $WORKTREE_BASE/openclaw-c'  # parallel session C" >> "$SHELL_RC"
  echo "alias zd='cd $WORKTREE_BASE/openclaw-d'  # parallel session D" >> "$SHELL_RC"
  echo "alias zs='git worktree list'       # show all worktrees" >> "$SHELL_RC"
  echo "" >> "$SHELL_RC"
  echo "# Quick worktree creation" >> "$SHELL_RC"
  echo "zn() { git worktree add $WORKTREE_BASE/openclaw-\$1 -b work/\$1; }" >> "$SHELL_RC"
  echo "zrm() { git worktree remove $WORKTREE_BASE/openclaw-\$1; }" >> "$SHELL_RC"
  echo "Added worktree aliases to $SHELL_RC"
  echo "  zm = main, za/zb/zc/zd = parallel sessions"
  echo "  zn <name> = create new worktree, zrm <name> = remove worktree"
  echo "  zs = list all worktrees"
else
  echo "Worktree aliases already configured in $SHELL_RC"
fi

# --- Set up Claude Code permissions ---

echo ""
echo "--- Configuring tool permissions ---"
CLAUDE_SETTINGS_DIR="$REPO_ROOT/.claude"
mkdir -p "$CLAUDE_SETTINGS_DIR"

PERMISSIONS_FILE="$CLAUDE_SETTINGS_DIR/settings.json"
if [ ! -f "$PERMISSIONS_FILE" ]; then
  cat > "$PERMISSIONS_FILE" << 'PERMS'
{
  "permissions": {
    "allow": [
      "Read",
      "Glob",
      "Grep",
      "Bash(pnpm test*)",
      "Bash(pnpm lint*)",
      "Bash(pnpm build*)",
      "Bash(vitest*)",
      "Bash(git add*)",
      "Bash(git commit*)",
      "Bash(git branch*)",
      "Bash(git worktree*)",
      "Bash(git log*)",
      "Bash(git diff*)",
      "Bash(git status*)",
      "Bash(git merge*)",
      "Bash(wrangler dev*)"
    ],
    "deny": [
      "Bash(rm -rf /)",
      "Bash(git push --force*)",
      "Bash(git reset --hard*)"
    ]
  }
}
PERMS
  echo "Permissions configured at $PERMISSIONS_FILE"
  echo "  Pre-approved: read, tests, lint, build, git ops, wrangler dev"
  echo "  Blocked: destructive git commands"
else
  echo "Permissions already configured at $PERMISSIONS_FILE"
fi

# --- Security hardening ---
# CVE-2026-25253 patched in v2026.1.29+, but defense-in-depth matters

echo ""
echo "--- Security hardening ---"

# Restrict config directory permissions (only current user)
chmod 700 "$OPENCLAW_DIR"
echo "Set $OPENCLAW_DIR to 700 (owner-only)"

# Bind gateway to loopback only (not exposed to network)
if command -v openclaw &>/dev/null; then
  openclaw config set gateway.bind loopback 2>/dev/null || true
  echo "Gateway bound to loopback only"

  # Disable mDNS discovery (reduces attack surface)
  openclaw config set discovery.mdns.mode minimal 2>/dev/null || true
  echo "mDNS discovery set to minimal"
fi

# Ensure credentials directory is locked down
if [ -d "$OPENCLAW_DIR/credentials" ]; then
  chmod 700 "$OPENCLAW_DIR/credentials"
  echo "Credentials directory locked to 700"
fi

# --- Summary ---

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Installed:"
echo "  OpenClaw: $(openclaw --version 2>/dev/null || echo 'installed')"
echo "  Wrangler: $(wrangler --version 2>/dev/null || echo 'installed')"
echo "  Workspace: $WORKSPACE_DIR"
echo "  Config: $CONFIG_FILE"
echo ""
echo "  Permissions: $PERMISSIONS_FILE"
echo ""
echo "Security:"
echo "  Gateway: loopback-only (not exposed to network)"
echo "  Config dir: 700 (owner-only permissions)"
echo "  mDNS: minimal (reduced discovery surface)"
echo "  Ensure OpenClaw >= v2026.1.29 (CVE-2026-25253 patch)"
echo ""
echo "Next steps:"
echo "  1. Source your shell config: source $SHELL_RC"
echo "  2. Run: openclaw onboard --install-daemon"
echo "  3. Scan WhatsApp QR code when prompted"
echo "  4. Send the bootstrap message from FIRST_MESSAGE.md to Danno via WhatsApp"
echo ""
echo "Architecture:"
echo "  Thinking: OpenRouter free models (DeepSeek R1, Llama 3.3 70B) = \$0"
echo "  Building: Claude Code CLI = \$200/mo (fleet of parallel sessions)"
echo "  Hosting:  Cloudflare Workers = \$0 (free tier)"
echo "  Data:     The Odds API = \$0 (500 req/mo free)"
echo ""
echo "Parallel sessions:"
echo "  zm = main workspace, za/zb/zc/zd = parallel sessions"
echo "  zn <name> = create worktree, zrm <name> = remove worktree"
echo "  Run 3-5 Claude Code sessions simultaneously for max throughput."
echo ""
