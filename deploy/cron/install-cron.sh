#!/usr/bin/env bash
#
# Install SHARPS EDGE cron jobs on macOS via launchd.
# Run this once on the Mac Mini after setup.
#
# Usage: ./install-cron.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

mkdir -p "$LAUNCH_AGENTS"

# Make scripts executable
chmod +x "$SCRIPT_DIR/daily-scan.sh"
chmod +x "$SCRIPT_DIR/weekly-calibrate.sh"

# Install daily scan
cp "$SCRIPT_DIR/com.sharps-edge.daily-scan.plist" "$LAUNCH_AGENTS/"
launchctl unload "$LAUNCH_AGENTS/com.sharps-edge.daily-scan.plist" 2>/dev/null || true
launchctl load "$LAUNCH_AGENTS/com.sharps-edge.daily-scan.plist"
echo "Installed: daily edge scan (10:00 AM daily)"

# Install weekly calibration
cp "$SCRIPT_DIR/com.sharps-edge.weekly-calibrate.plist" "$LAUNCH_AGENTS/"
launchctl unload "$LAUNCH_AGENTS/com.sharps-edge.weekly-calibrate.plist" 2>/dev/null || true
launchctl load "$LAUNCH_AGENTS/com.sharps-edge.weekly-calibrate.plist"
echo "Installed: weekly calibration (Monday 6:00 AM)"

echo ""
echo "Cron jobs installed. Verify with:"
echo "  launchctl list | grep sharps-edge"
echo ""
echo "Manual run:"
echo "  $SCRIPT_DIR/daily-scan.sh"
echo "  $SCRIPT_DIR/weekly-calibrate.sh"
