#!/usr/bin/env bash
# Start the Go AI Server (KataGo + style knowledge + opening book)
# Runs in background; logs go to stderr

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$PROJECT_ROOT/engines/logs/go-ai-server.log"

mkdir -p "$(dirname "$LOG_FILE")"

echo "[GoAI Server] Starting on port 8200..."
python3 "$PROJECT_ROOT/lib/go-ai-server/go_ai_server.py" \
  >> "$LOG_FILE" 2>&1 &

SERVER_PID=$!
echo $SERVER_PID > "$PROJECT_ROOT/.go-ai-server.pid"
echo "[GoAI Server] PID $SERVER_PID, logs: $LOG_FILE"
