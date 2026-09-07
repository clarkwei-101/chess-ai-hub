#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
ENGINES_DIR="engines"
mkdir -p "$ENGINES_DIR/networks"

echo "=================================================="
echo "  Chess AI Hub — Engine Downloader"
echo "=================================================="

ARCH=$(uname -m)
echo "Architecture: $ARCH"

# ---------- 1. Stockfish 18 ----------
if [ ! -f "$ENGINES_DIR/stockfish" ]; then
  echo "Downloading Stockfish 18..."
  if [ "$ARCH" = "arm64" ]; then
    SF_URL="https://github.com/official-stockfish/Stockfish/releases/download/sf_18/stockfish-macos-m1-apple-silicon.tar"
  else
    SF_URL="https://github.com/official-stockfish/Stockfish/releases/download/sf_18/stockfish-macos-x86-64-modern.tar"
  fi
  cd "$ENGINES_DIR"
  curl -L --fail -o sf.tar "$SF_URL" || { echo "Stockfish download failed"; exit 1; }
  tar -xf sf.tar
  rm -f sf.tar
  SF_BIN=$(find . -name "stockfish*" -type f -perm +111 2>/dev/null | head -1)
  if [ -z "$SF_BIN" ]; then
    SF_BIN=$(find . -name "stockfish*" -type f 2>/dev/null | head -1)
  fi
  if [ -n "$SF_BIN" ]; then
    cp "$SF_BIN" stockfish
    chmod +x stockfish
    echo "Stockfish 18 installed"
  else
    echo "Stockfish binary not found"
    find . -maxdepth 3 -type f | head -10
    exit 1
  fi
  cd ..
else
  echo "Stockfish 18 already present"
fi

# ---------- 2. Pikafish ----------
if [ ! -f "$ENGINES_DIR/pikafish" ]; then
  echo "Downloading Pikafish 2026-01-02..."
  PIKAFISH_URL="https://github.com/official-pikafish/Pikafish/releases/download/Pikafish-2026-01-02/Pikafish.2026-01-02.7z"
  cd "$ENGINES_DIR"
  if command -v 7z >/dev/null 2>&1 || command -v 7za >/dev/null 2>&1; then
    curl -L --fail -o pik.7z "$PIKAFISH_URL" || { echo "Pikafish download failed"; exit 1; }
    (command -v 7z >/dev/null && 7z x -y pik.7z) || 7za x -y pik.7z
    rm -f pik.7z
  else
    # Fallback: try tar.gz, but Pikafish releases only 7z; install 7z via brew if missing
    if ! brew list --formula 2>/dev/null | grep -q p7zip; then
      echo "Installing p7zip via Homebrew (needed for Pikafish .7z extraction)..."
      brew install p7zip >/dev/null 2>&1 || true
    fi
    curl -L --fail -o pik.7z "$PIKAFISH_URL" || { echo "Pikafish download failed"; exit 1; }
    7z x -y pik.7z || { echo "7z not available; install with: brew install p7zip"; exit 1; }
    rm -f pik.7z
  fi
  PIK_BIN=$(find . -name "pikafish*" -type f -perm +111 2>/dev/null | head -1)
  if [ -z "$PIK_BIN" ]; then
    PIK_BIN=$(find . -name "Pikafish*" -type f -perm +111 2>/dev/null | head -1)
  fi
  if [ -z "$PIK_BIN" ]; then
    PIK_BIN=$(find . -name "*.exe" -o -name "*pikafish*" -o -name "*Pikafish*" 2>/dev/null | grep -v "\.7z\|\.md\|\.txt" | head -1)
  fi
  if [ -n "$PIK_BIN" ] && [ -f "$PIK_BIN" ]; then
    cp "$PIK_BIN" pikafish
    chmod +x pikafish
    echo "Pikafish installed"
  else
    echo "Pikafish binary not found"
    find . -maxdepth 3 -type f | head -20
    exit 1
  fi
  cd ..
else
  echo "Pikafish already present"
fi

# ---------- 3. KataGo ----------
if [ ! -f "$ENGINES_DIR/katago" ]; then
  echo "Downloading KataGo v1.18.1 (macOS Metal)..."
  KATAGO_URL="https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-macos-Catalina.zip"
  cd "$ENGINES_DIR"
  curl -L --fail -o katago.zip "$KATAGO_URL" || { echo "KataGo download failed"; exit 1; }
  unzip -q -o katago.zip
  rm -f katago.zip
  KG_BIN=$(find . -name "katago" -type f -perm +111 2>/dev/null | head -1)
  if [ -z "$KG_BIN" ]; then
    KG_BIN=$(find . -name "katago" -type f 2>/dev/null | head -1)
  fi
  if [ -n "$KG_BIN" ]; then
    cp "$KG_BIN" katago
    chmod +x katago
    echo "KataGo installed"
  else
    echo "KataGo binary not found"
    find . -maxdepth 3 -type f -name "*katago*" | head -10
    exit 1
  fi
  cd ..
else
  echo "KataGo already present"
fi

# ---------- 4. KataGo neural net ----------
if [ ! -f "$ENGINES_DIR/networks/kata1-b18c384nbt-autov2.bin" ]; then
  echo "Downloading KataGo neural net..."
  cd "$ENGINES_DIR/networks"
  curl -L --fail -o kata1-b18c384nbt-autov2.bin.gz \
    "https://media.katagotraining.org/uploaded/networks/kata1/kata1-b18c384nbt-autov2.bin.gz" \
    || { echo "Neural net download failed"; exit 1; }
  gunzip -f kata1-b18c384nbt-autov2.bin.gz
  echo "Neural net installed"
  cd ../..
else
  echo "Neural net already present"
fi

echo ""
echo "=================================================="
echo "  All engines ready!"
echo "=================================================="
ls -la "$ENGINES_DIR" | grep -v "^total"