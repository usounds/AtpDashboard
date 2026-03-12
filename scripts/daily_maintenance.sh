#!/bin/bash
# Daily Maintenance Script for AtpDashboard
# This script is intended to be run via cron.

# PSQL Executable Path (Adjust if necessary)
# Using direct path to avoid PATH issues in cron
PSQL="/opt/homebrew/opt/libpq/bin/psql"

# Fallback to system psql if specific path not found
if [ ! -x "$PSQL" ]; then
    PSQL="psql"
fi

# Database Configuration
DB_HOST="localhost"
DB_PORT="7800"
DB_USER="postgres"
DB_NAME="ocustomfeeddb"

# Resolve Project Root (Parent of the script directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

LOG_FILE="$PROJECT_ROOT/cron_maintenance.log"

{
    echo "========================================"
    echo "Starting daily maintenance at $(date)"
    
    echo "Running daily_active_did.sql..."
    $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f "$PROJECT_ROOT/sql/cron/daily_active_did.sql"
    
    echo "Running daily_collection_stats.sql..."
    $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f "$PROJECT_ROOT/sql/cron/daily_collection_stats.sql"
    
    echo "Maintenance completed at $(date)"
    echo "========================================"
} >> "$LOG_FILE" 2>&1
