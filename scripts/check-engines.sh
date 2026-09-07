#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
ENGINES_DIR="engines"

echo "=================================================="
echo "  Engine Health Check"
echo "=================================================="

# Stockfish
if [ -x "$ENGINES_DIR/stockfish" ]; then
  echo -n "Stockfish: "
  OUT=$("$ENGINES_DIR/stockfish" <<'EOF' 2>/dev/null | head -20 || true
uci
isready
quit
EOF
)
  echo "$OUT" | grep -q "uciok" && echo "OK (UCI)" || echo "WARN (no uciok)"
else
  echo "Stockfish: MISSING (run npm run engines:download)"
fi

# Pikafish — speaks UCI (NOT UCCI)
if [ -x "$ENGINES_DIR/pikafish" ]; then
  echo -n "Pikafish: "
  OUT=$("$ENGINES_DIR/pikafish" <<'EOF' 2>/dev/null | head -20 || true
uci
isready
quit
EOF
)
  echo "$OUT" | grep -q "uciok" && echo "OK (UCI)" || echo "WARN (no uciok)"
else
  echo "Pikafish: MISSING (run npm run engines:download)"
fi

# KataGo
if [ -x "$ENGINES_DIR/katago" ] && [ -f "$ENGINES_DIR/networks/kata1-tf2-b10c384-s2941M-d5872M.bin.gz" ]; then
  echo -n "KataGo: "
  "$ENGINES_DIR/katago" version 2>&1 | head -1
elif [ -L "$ENGINES_DIR/katago" ]; then
  echo -n "KataGo: "
  "$ENGINES_DIR/katago" version 2>&1 | head -1 || echo "OK (symlinked)"
else
  echo "KataGo: MISSING (run npm run engines:download)"
fi
