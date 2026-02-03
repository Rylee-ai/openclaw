#!/usr/bin/env bash
#
# SHARPS EDGE - Weekly Calibration
#
# Runs calibration correction to update prediction accuracy.
# Should run after enough picks have resolved (weekly is good cadence).
#
# Install via launchd (macOS) or crontab:
#   crontab: 0 6 * * 1  /path/to/weekly-calibrate.sh  (Monday 6am)
#   launchd: see com.sharps-edge.weekly-calibrate.plist

set -euo pipefail

WEEK=$(date +%Y-W%V)
LOG_DIR="$HOME/.openclaw/workspace/data/calibration-logs"
LOG_FILE="$LOG_DIR/calibrate-$WEEK.log"

mkdir -p "$LOG_DIR"

echo "=== Weekly Calibration: $WEEK ===" > "$LOG_FILE"
echo "Started: $(date)" >> "$LOG_FILE"

# Ask the agent to run calibration
CAL_MSG="Run weekly calibration: 1) Use 'calibrate report' to see current accuracy breakdown. 2) Use 'calibrate correct' to recalculate correction factors from all resolved picks. 3) Use 'review_accuracy' to check overall pick performance. Report the results concisely."

openclaw message send --agent main "$CAL_MSG" 2>/dev/null || {
  echo "Calibration failed" >> "$LOG_FILE"
  exit 1
}

echo "Completed: $(date)" >> "$LOG_FILE"
