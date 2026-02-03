# SHARPS EDGE Operations Guide

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Mac Mini                          │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐                │
│  │ OpenClaw     │  │ Claude Code  │                │
│  │ (Danno)      │  │ (Builder)    │                │
│  │              │  │              │                │
│  │ WhatsApp ◄───┤  │ Code + Deploy│                │
│  │ 9 Tools      │  │ Parallel x5  │                │
│  │ Edge Models  │  │              │                │
│  └──────────────┘  └──────────────┘                │
│         │                   │                       │
│    Operator Layer      Builder Layer                │
│                                                     │
│  ┌──────────────────────────────────┐              │
│  │ Cron Jobs                        │              │
│  │  - Daily scan (10am)             │              │
│  │  - Weekly calibration (Mon 6am)  │              │
│  └──────────────────────────────────┘              │
└─────────────────────────────────────────────────────┘
          │
          ▼ (deployed via wrangler)
┌─────────────────────────────────────┐
│ Cloudflare Workers                  │
│                                     │
│  sharps-edge-api                    │
│  ├── /health       (free)           │
│  ├── /sports       (free)           │
│  ├── /games        (free)           │
│  ├── /quick-check  (x402: $0.10)   │
│  ├── /line-check   (x402: $0.25)   │
│  └── /full-analysis(x402: $1.00)   │
│                                     │
│  Payment: USDC on Base L2           │
│  Cache: Cloudflare KV               │
└─────────────────────────────────────┘
```

## Daily Operations

### 1. Automated (cron runs these)

- **10:00 AM**: Daily edge scan across NBA/NHL (NFL on game days)
- **Monday 6:00 AM**: Weekly calibration correction

Results stored in `~/.openclaw/workspace/data/daily-scans/`
and `~/.openclaw/workspace/data/calibration-logs/`.

### 2. Manual via WhatsApp

Message Danno with commands like:
- "Check edge on DAL@PHI in NBA"
- "What are today's NBA edges?"
- "Track pick: BOS -3.5 vs NYK, confidence 62%"
- "Review accuracy for this month"
- "Calibrate check 65" (get calibrated confidence for 65%)

### 3. Builder Sessions (Claude Code)

For code changes, deployments, new features:

```bash
# Start a builder session
cd ~/openclaw
claude   # or: openclaw builder start (if configured)
```

Builder sessions can:
- Write and deploy code
- Update the Worker
- Add new tools
- Fix bugs
- Run tests

Run up to 5 parallel sessions using the worktree aliases:
```bash
zm    # main workspace
za    # parallel session A
zb    # parallel session B
zc    # parallel session C
zd    # parallel session D
```

## Setup Checklist

### First Time

1. Run setup script: `~/openclaw/deploy/mac-mini/setup-mac-mini.sh`
2. Onboard OpenClaw: `openclaw onboard --install-daemon`
3. Install plugin: `openclaw plugins install ./extensions/sharps-edge`
4. Install cron jobs: `~/openclaw/deploy/cron/install-cron.sh`
5. Deploy Worker: see "Deploy Worker" below

### Deploy Worker

```bash
cd ~/openclaw/deploy/workers

# Install deps
npm install

# Create KV namespace
npx wrangler kv namespace create CACHE
# Copy the id into wrangler.toml

npx wrangler kv namespace create CACHE --preview
# Copy the preview_id into wrangler.toml

# Set secrets
npx wrangler secret put THE_ODDS_API_KEY
npx wrangler secret put X402_WALLET_ADDRESS

# Deploy
npx wrangler deploy

# Test
curl https://sharps-edge-api.<your-account>.workers.dev/health
```

### x402 Payments

The Worker uses the Coinbase x402 protocol for monetization:

1. **Get a Base L2 wallet** (Coinbase Wallet, MetaMask, etc.)
2. **Set wallet address** as `X402_WALLET_ADDRESS` secret
3. **Pricing tiers**:
   - `/quick-check`: $0.10 USDC per request
   - `/line-check`: $0.25 USDC per request
   - `/full-analysis`: $1.00 USDC per request
4. Payments verified onchain via Base L2 RPC

If `X402_WALLET_ADDRESS` is not set, endpoints serve for free (dev mode).

### API Keys

| Key | Where to get | Free tier |
|-----|-------------|-----------|
| THE_ODDS_API_KEY | the-odds-api.com | 500 req/mo |
| OPENROUTER_API_KEY | openrouter.ai | Free models available |
| X402_WALLET_ADDRESS | Any Base L2 wallet | N/A |

### Cost Structure

| Component | Cost | Notes |
|-----------|------|-------|
| OpenRouter (DeepSeek R1) | $0 | Free model |
| OpenRouter (Llama 3.3 70B) | $0 | Free model |
| The Odds API | $0 | 500 req/mo free |
| Open-Meteo weather | $0 | Unlimited |
| ESPN public APIs | $0 | Unlimited |
| Cloudflare Workers | $0 | 100k req/day free |
| Cloudflare KV | $0 | 100k reads/day free |
| **Total infrastructure** | **$0/mo** | |
| Claude Code (builder) | $200/mo | Max plan |

Revenue target: $200/mo (breakeven on Claude Code subscription).

## Monitoring

```bash
# Check OpenClaw status
openclaw doctor

# Check cron logs
cat /tmp/sharps-edge-daily-scan.log
cat /tmp/sharps-edge-weekly-calibrate.log

# Check Worker logs
cd ~/openclaw/deploy/workers && npx wrangler tail

# Check daily scan results
ls ~/.openclaw/workspace/data/daily-scans/

# Check calibration state
cat ~/.openclaw/workspace/data/calibration.json
```
