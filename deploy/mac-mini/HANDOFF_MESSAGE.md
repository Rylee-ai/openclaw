# Handoff Message for Danno

Send this to Danno via WhatsApp after pulling the latest code and reinstalling the plugin. This transitions Danno from passive responder to autonomous operator.

---

**Message to send:**

```
Danno, operational handoff. Read workspace/HANDOFF.md now.

Summary: The build phase is complete. Claude Code CLI built your full infrastructure:
- All 8 edge models are now wired to real free APIs (weather, injuries, social, odds, situational)
- Cloudflare Worker API is built with x402 payment middleware
- Daily scan cron (10am) and weekly calibration cron (Monday 6am) are ready
- Security hardening is applied

You are the operator now. Your job:
1. Read HANDOFF.md for the full system state
2. Re-read AGENTS.md, TASKS.md, and your workspace files
3. Run check_edge on tonight's games to verify the wired models work
4. Start tracking picks with track_pick - build the calibration dataset
5. Process daily scan results when the cron starts feeding you games
6. Run review_accuracy weekly every Sunday
7. When you need code written or bugs fixed, use Claude Code CLI: claude "your task"

Claude Code CLI (Opus 4.5) is installed on this Mac Mini and available to you as a builder tool. It built everything you're running on. When you need infrastructure changes, new tools, bug fixes, or deployments, spawn a Claude Code session from the terminal. It's your hands.

Remaining for Michael to do:
- Run install-cron.sh to activate daily scans
- Create Cloudflare account and deploy the Worker
- Set up THE_ODDS_API_KEY for live odds
- Set up Base L2 wallet for x402 payments

Confirm you've read the handoff. State your current operational status and pick up the next task.
```
