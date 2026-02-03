# TASKS: SHARPS-EDGE

Work tasks top to bottom. Do not skip ahead unless blocked.

## Phase 1: Foundation

- [x] Set up Cloudflare Workers project with Hono framework
- [x] Implement /health endpoint (returns service status)
- [x] Integrate The Odds API client with caching layer
- [x] Implement /sports endpoint (list available sports)
- [x] Set up cost tracking for API calls
- [x] Implement /games endpoint (today's available games)

## Phase 2: Core Endpoints

- [x] Implement /quick-check endpoint (fast odds summary)
- [x] Implement /line-check endpoint (line movement analysis)
- [x] Design multi-model consensus analysis engine
- [x] Implement /full-analysis endpoint (premium analysis)
- [x] Integrate ESPN data for enrichment (injuries + social)
- [x] Integrate Open-Meteo weather data for outdoor sports
- [x] Wire check-edge plugin to real data sources (8 models live)

## Phase 3: Payment

- [x] Research x402 micropayment protocol integration
- [x] Implement x402 payment middleware for Hono
- [x] Set pricing tiers per endpoint ($0.10 / $0.25 / $1.00)
- [ ] Test payment flow end-to-end (testnet)
- [ ] Deploy with live payments

## Phase 4: Automation

- [x] Build daily edge scanner (cron, 10am daily)
- [x] Build weekly calibration loop (cron, Monday 6am)
- [x] Create macOS launchd plists for cron jobs
- [x] Create install-cron.sh for one-command setup
- [ ] Install cron jobs on Mac Mini
- [ ] Verify daily scans running

## Phase 5: Deployment

- [ ] Create Cloudflare account (free)
- [ ] Create KV namespace for caching
- [ ] Set API key secrets (THE_ODDS_API_KEY)
- [ ] Set up Base L2 wallet for x402 payments
- [ ] Deploy Worker via `wrangler deploy`
- [ ] Verify /health endpoint live
- [ ] Test /quick-check with real game data
- [ ] First x402 payment received

## Phase 6: Polish

- [ ] Add comprehensive error handling and graceful degradation
- [ ] Optimize caching strategy for Odds API quota
- [ ] Add rate limiting
- [ ] Write API documentation
- [ ] Monitor and optimize costs

## Completed

- OpenClaw fork set up with SHARPS EDGE plugin
- 9 handicapping tools registered (get-odds, get-weather, get-injuries, get-social, situational, check-edge, track-pick, review-accuracy, calibrate)
- 8 edge models wired to real free APIs
- Plugin deployed on Mac Mini, WhatsApp bot responding
- Security hardening applied (loopback gateway, allowlist DM, 700 perms)
- Cloudflare Worker built with Hono + x402 middleware
- Daily scanner + weekly calibration cron jobs built
- Operations guide written
