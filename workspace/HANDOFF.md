# HANDOFF: Claude Code CLI -> Danno

**Date:** 2026-02-03
**From:** Claude Code CLI (Builder Agent, Opus 4.5)
**To:** Danno (SHARPS EDGE Operator Agent)
**Operator:** Michael

---

## Status: You Are Operational

Danno, this document marks the formal handoff of daily operations from the build phase to your autonomous management. Everything below is live and working on this Mac Mini.

## What Was Built (Your Infrastructure)

### Plugin: SHARPS EDGE (9 Tools, 8 Edge Models)
All installed at `~/.openclaw/extensions/sharps-edge/`. All tools are registered and functional.

**Data Collection Tools:**
- `get_odds` - The Odds API (500 req/mo free, 10-min cache)
- `get_weather` - Open-Meteo (free, unlimited)
- `get_injuries` - ESPN public (free, unlimited)
- `get_social` - ESPN news (free, unlimited)
- `get_situational` - ESPN schedules (free, unlimited)

**Analysis Tools:**
- `check_edge` - **NOW WIRED TO REAL DATA.** All 8 models call live APIs:
  1. Line Value (odds spread analysis across books)
  2. RLM Proxy (sharp vs public book divergence)
  3. Weather Impact (Open-Meteo -> scoring adjustments)
  4. Injury Context (ESPN -> underpriced role player detection)
  5. Social Signals (ESPN news -> sentiment analysis)
  6. Stale Line Detection (multi-book outlier detection)
  7. Situational Spots (rest, travel, timezone, altitude, schedule density)
  8. Calibration Overlay (probability correction from resolved picks)

**Learning Tools:**
- `track_pick` - Record and resolve picks for CLV tracking
- `review_accuracy` - 9 analytics actions for model improvement
- `calibrate` - Probability calibration engine (the trust engine)

### Cloudflare Worker API (Ready to Deploy)
Code is built at `~/openclaw/deploy/workers/`. Endpoints:
- `/health`, `/sports`, `/games` - free discovery endpoints
- `/quick-check` ($0.10), `/line-check` ($0.25), `/full-analysis` ($1.00) - x402 gated
- Needs: Cloudflare account, KV namespace, wallet address. Michael will handle deployment.

### Automated Operations (Ready to Install)
- **Daily scan** (10am): Scans all NBA/NHL games, NFL on game days
- **Weekly calibration** (Monday 6am): Recalculates correction factors
- Install script: `~/openclaw/deploy/cron/install-cron.sh`

### Security Hardening (Applied)
- Gateway bound to loopback only
- WhatsApp DM policy: allowlist
- Config directory: 700 permissions
- OpenClaw v2026.2.1 (CVE-2026-25253 patched)

## What You Own Now

### Daily Operations (Autonomous - No Michael Needed)
1. **Respond to WhatsApp messages** - Run edge analysis when asked
2. **Process daily scan results** - The cron job feeds you games; analyze and surface edges
3. **Track every pick** - Use `track_pick record` for every recommendation. No exceptions.
4. **Backfill results** - After games complete, use `track_pick result` to log outcomes
5. **Monitor budget** - Track API call costs, stay within free tiers
6. **Log everything** - Decisions, conflicts, errors go to `logs/`

### Weekly Operations (Autonomous)
1. **Sunday review** - Run `review_accuracy weekly` for full performance breakdown
2. **Monday calibration** - Cron handles `calibrate correct` automatically
3. **Model weight adjustment** - Based on review, adjust weights (max +-5% per cycle)
4. **Write memory** - Persist lessons to `MEMORY.md` and `memory/YYYY-MM-DD.md`

### Escalate to Michael For
1. **Deploying the Worker** - Needs Cloudflare account setup
2. **Setting up x402 wallet** - Needs Base L2 wallet
3. **Budget changes** - Only Michael approves budget increases
4. **CHARTER.md changes** - Governance changes need human approval

## Claude Code CLI: Your Builder Tool

When you need code written, infrastructure changes, or bug fixes, you have access to Claude Code CLI. It runs directly on this Mac Mini.

**How to use it:**
```bash
# Simple task
claude "Fix the bug in check-edge where RLM returns 0 for Pinnacle games"

# Complex task (Plan Mode first)
claude "Enter Plan Mode. Design a new edge model for pitcher matchup analysis in MLB."

# Parallel tasks
# Terminal 1: claude "Build the /pitcher-matchup endpoint"
# Terminal 2: claude "Write tests for the weather model"
# Terminal 3: claude "Audit ESPN API for new data sources"
```

**What Claude Code can do:**
- Write, edit, and test TypeScript code
- Deploy Cloudflare Workers
- Git operations (commit, branch, merge)
- Run the full test suite
- Debug from error logs
- Scaffold new tools and endpoints

**What Claude Code cannot do:**
- Make decisions about what to build (that's your job based on TASKS.md)
- Approve budget or scope changes (that's Michael's job)
- Run indefinitely (sessions end; persist state to workspace files)

## The Learning Loop

This is the core competitive advantage. Every game makes the system smarter:

```
Game Day:
  check_edge -> analyze -> track_pick record -> recommend

Post-Game:
  track_pick result -> backfill outcome + closing line

Weekly:
  review_accuracy weekly -> identify model strengths/weaknesses
  review_accuracy calibration -> check predicted vs actual
  review_accuracy compound -> find best model combinations

Monthly:
  calibrate correct -> update correction factors
  review_accuracy regimes -> detect if market conditions changed
  review_accuracy portfolio -> check for correlated exposure

Continuous:
  Every lesson -> MEMORY.md
  Every mistake -> fix + update workspace files
  Every model tweak -> logs/decisions/
```

After 100 picks, the calibration engine starts producing real correction factors.
After 500 picks, the model weights reflect proven accuracy per sport.
After 1000 picks, the system knows exactly where its edge is and where it isn't.

## Current State

| Component | Status |
|-----------|--------|
| OpenClaw | v2026.2.1, running, WhatsApp linked |
| Plugin | 9 tools, 8 models, all wired to real APIs |
| Cron | Built, needs `install-cron.sh` run |
| Worker API | Built, needs Cloudflare deployment |
| x402 Payments | Code ready, needs wallet setup |
| Calibration data | Empty (0 picks tracked) |
| Model weights | Default (no adjustments yet) |

## Your First Autonomous Actions

1. Read all workspace files (AGENTS.md, SOUL.md, etc.) to reinitialize
2. Read `projects/SHARPS-EDGE/TASKS.md` for current task queue
3. Run `check_edge` on tonight's NBA games to verify tools work end-to-end
4. Track any recommendations with `track_pick record`
5. Start building your calibration dataset

The build phase is complete. You are the operator now.

---

*This handoff was created by Claude Code CLI (Opus 4.5) during the initial build session. The fork repo is at github.com/Rylee-ai/openclaw on branch `claude/research-open-claw-fork-JFzQS`. All infrastructure is free-tier. The only paid component is the Claude Code CLI subscription ($200/mo) which Michael manages.*
