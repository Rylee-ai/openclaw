#!/usr/bin/env bash
#
# SHARPS EDGE - Daily Edge Scanner
#
# Runs check_edge across all available games for each sport.
# Results stored in ~/.openclaw/workspace/data/daily-scans/
# Games with MODERATE or STRONG edges sent as WhatsApp summary.
#
# Install via launchd (macOS) or crontab:
#   crontab: 0 10 * * * /path/to/daily-scan.sh
#   launchd: see com.sharps-edge.daily-scan.plist

set -euo pipefail

SCAN_DIR="$HOME/.openclaw/workspace/data/daily-scans"
TODAY=$(date +%Y-%m-%d)
SCAN_FILE="$SCAN_DIR/$TODAY.jsonl"
SUMMARY_FILE="$SCAN_DIR/$TODAY-summary.txt"

mkdir -p "$SCAN_DIR"

echo "=== SHARPS EDGE Daily Scan: $TODAY ===" > "$SUMMARY_FILE"
echo "" >> "$SUMMARY_FILE"

EDGES_FOUND=0

# Scan each sport
for SPORT in nba nhl; do
  echo "Scanning $SPORT..." >> "$SUMMARY_FILE"

  # Ask the agent to scan games via openclaw message send
  # The agent will use check_edge tool for each game
  SCAN_MSG="Run a daily edge scan for ${SPORT} today. For each game available, run check_edge with depth=standard. Report any games with MODERATE or STRONG edge scores. Be concise - just list game, edge score, direction, and key reason for each edge found. If no edges, say 'No edges found for ${SPORT}.' Store results in the workspace."

  openclaw message send --agent main "$SCAN_MSG" 2>/dev/null || {
    echo "  Failed to scan $SPORT" >> "$SUMMARY_FILE"
    continue
  }

  echo "  $SPORT scan complete" >> "$SUMMARY_FILE"
done

# NFL only on specific days (Thursday, Sunday, Monday)
DOW=$(date +%u)  # 1=Monday, 7=Sunday
if [ "$DOW" = "1" ] || [ "$DOW" = "4" ] || [ "$DOW" = "7" ]; then
  echo "Scanning nfl (game day)..." >> "$SUMMARY_FILE"
  openclaw message send --agent main \
    "Run a daily edge scan for NFL today. Check all games with depth=full (it's game day). Report edges found." \
    2>/dev/null || echo "  Failed to scan nfl" >> "$SUMMARY_FILE"
fi

echo "" >> "$SUMMARY_FILE"
echo "Scan complete: $TODAY" >> "$SUMMARY_FILE"
echo "Results: $SCAN_DIR/" >> "$SUMMARY_FILE"
