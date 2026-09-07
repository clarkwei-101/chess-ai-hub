#!/bin/bash
# Start the Chess AI Hub Visual Server on port 3003
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="/opt/homebrew/bin/python3"

echo "Starting Chess AI Hub Visual Server on port 3003..."
"$PYTHON" "$SCRIPT_DIR/../visual/server.py" &
sleep 2

if curl -s http://localhost:3003/status > /dev/null 2>&1; then
  echo "Visual server running at http://localhost:3003"
else
  echo "WARNING: Visual server may not have started correctly"
fi
