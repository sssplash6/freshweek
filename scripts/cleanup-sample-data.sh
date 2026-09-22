#!/bin/bash
# Deletes the seed_ sample rows from the local freshman_weekly DB, then removes
# the launchd job that invoked it. Scheduled by the LaunchAgent
# local.freshweek.seedcleanup (see ~/Library/LaunchAgents).
PSQL=/opt/homebrew/opt/postgresql@17/bin/psql
LOG=/tmp/freshweek-seed-cleanup.log
{
  echo "=== $(date) ==="
  "$PSQL" freshman_weekly -f "$(dirname "$0")/cleanup-sample-data.sql"
} >> "$LOG" 2>&1
launchctl bootout "gui/$(id -u)/local.freshweek.seedcleanup" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/local.freshweek.seedcleanup.plist"
