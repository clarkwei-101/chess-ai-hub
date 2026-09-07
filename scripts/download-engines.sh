#!/usr/bin/env bash
# ============================================================
# Chess AI Hub — engine bootstrap
# Idempotent: safe to run multiple times. Skips what exists.
# Cross-platform: macOS (arm64/x64) + Linux.
# ============================================================
set -e

cd "$(dirname "$0")/.."
ENGINES_DIR="engines"
mkdir -p "$ENGINES_DIR/networks"

ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
echo "=================================================="
echo "  Chess AI Hub — Engine Bootstrap"
echo "  OS=$OS  ARCH=$ARCH"
echo "=================================================="

# ---------- helpers ----------
download() {
  local url="$1"
  local out="$2"
  if [ -f "$out" ] && [ -s "$out" ]; then
    echo "  ✓ already exists: $out"
    return 0
  fi
  echo "  → downloading $url"
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --retry 3 -o "$out" "$url" || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$out" "$url" || return 1
  else
    echo "  ✗ need curl or wget" >&2
    return 1
  fi
}

extract() {
  local archive="$1"
  local outdir="$2"
  case "$archive" in
    *.tar) tar -xf "$archive" -C "$outdir" ;;
    *.tar.gz|*.tgz) tar -xzf "$archive" -C "$outdir" ;;
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        unzip -q -o "$archive" -d "$outdir"
      elif command -v 7z >/dev/null 2>&1; then
        7z x -y "$archive" -o"$outdir" >/dev/null
      else
        echo "  ✗ need unzip or 7z" >&2
        return 1
      fi
      ;;
    *.7z)
      if ! command -v 7z >/dev/null 2>&1 && ! command -v 7za >/dev/null 2>&1; then
        echo "  ✗ need p7zip (brew install p7zip / apt-get install p7zip-full)" >&2
        return 1
      fi
      (command -v 7z >/dev/null && 7z x -y "$archive" -o"$outdir" >/dev/null) || 7za x -y "$archive" -o"$outdir" >/dev/null
      ;;
    *) echo "  ✗ unknown archive: $archive" >&2; return 1 ;;
  esac
}

# ---------- 1. Stockfish 18 ----------
echo ""
echo "[1/4] Stockfish 18 (国际象棋 / Chess)"
if [ ! -x "$ENGINES_DIR/stockfish" ] || [ ! -s "$ENGINES_DIR/stockfish" ]; then
  SF_TAR="$ENGINES_DIR/_sf.tar"
  case "$OS-$ARCH" in
    darwin-arm64) SF_URL="https://github.com/official-stockfish/Stockfish/releases/download/sf_18/stockfish-macos-m1-apple-silicon.tar" ;;
    darwin-x86_64) SF_URL="https://github.com/official-stockfish/Stockfish/releases/download/sf_18/stockfish-macos-x86-64-modern.tar" ;;
    linux-x86_64) SF_URL="https://github.com/official-stockfish/Stockfish/releases/download/sf_18/stockfish-ubuntu-x86-64-avx2.tar" ;;
    linux-aarch64) SF_URL="https://github.com/official-stockfish/Stockfish/releases/download/sf_18/stockfish-ubuntu-arm64.tar" ;;
    *)
      echo "  ⚠ no prebuilt Stockfish for $OS-$ARCH — try 'brew install stockfish' or 'apt install stockfish'"
      SF_URL=""
      ;;
  esac
  if [ -n "$SF_URL" ] && download "$SF_URL" "$SF_TAR"; then
    (cd "$ENGINES_DIR" && tar -xf _sf.tar && rm -f _sf.tar)
    SF_BIN=$(find "$ENGINES_DIR" -maxdepth 3 -name "stockfish*" -type f -perm +111 2>/dev/null | head -1)
    if [ -z "$SF_BIN" ]; then
      SF_BIN=$(find "$ENGINES_DIR" -maxdepth 3 -name "stockfish*" -type f 2>/dev/null | grep -v "\.tar\|\.md" | head -1)
    fi
    if [ -n "$SF_BIN" ]; then
      cp -f "$SF_BIN" "$ENGINES_DIR/stockfish"
      chmod +x "$ENGINES_DIR/stockfish"
      echo "  ✓ Stockfish installed"
    fi
  fi
  # Fallback: homebrew / apt
  if [ ! -x "$ENGINES_DIR/stockfish" ] || [ ! -s "$ENGINES_DIR/stockfish" ]; then
    echo "  → trying package manager fallback"
    if [ "$OS" = "darwin" ] && command -v brew >/dev/null 2>&1 && brew list stockfish >/dev/null 2>&1; then
      ln -sf "$(brew --prefix stockfish)/bin/stockfish" "$ENGINES_DIR/stockfish"
    elif [ "$OS" = "linux" ] && command -v apt-get >/dev/null 2>&1 && dpkg -s stockfish >/dev/null 2>&1; then
      ln -sf /usr/games/stockfish "$ENGINES_DIR/stockfish"
    fi
  fi
else
  echo "  ✓ Stockfish already present"
fi

# ---------- 2. Pikafish ----------
echo ""
echo "[2/4] Pikafish 2026 (中国象棋 / Xiangqi)"
if [ ! -x "$ENGINES_DIR/pikafish" ] || [ ! -s "$ENGINES_DIR/pikafish" ]; then
  case "$OS-$ARCH" in
    darwin-arm64|darwin-x86_64)
      PIK_URL="https://github.com/official-pikafish/Pikafish/releases/download/Pikafish-2026-01-02/Pikafish.2026-01-02.7z"
      PIK_ARCHIVE="$ENGINES_DIR/_pik.7z"
      ;;
    linux-x86_64) PIK_URL="https://github.com/official-pikafish/Pikafish/releases/download/Pikafish-2026-01-02/Pikafish-Linux.7z"; PIK_ARCHIVE="$ENGINES_DIR/_pik.7z" ;;
    linux-aarch64) PIK_URL="https://github.com/official-pikafish/Pikafish/releases/download/Pikafish-2026-01-02/Pikafish-Linux-aarch64.7z"; PIK_ARCHIVE="$ENGINES_DIR/_pik.7z" ;;
    *)
      echo "  ⚠ no prebuilt Pikafish for $OS-$ARCH"
      PIK_URL=""
      ;;
  esac
  if [ -n "$PIK_URL" ] && download "$PIK_URL" "$PIK_ARCHIVE"; then
    if extract "$PIK_ARCHIVE" "$ENGINES_DIR"; then
      rm -f "$PIK_ARCHIVE"
      PIK_BIN=$(find "$ENGINES_DIR" -maxdepth 3 -iname "pikafish*" -type f -perm +111 2>/dev/null | head -1)
      [ -z "$PIK_BIN" ] && PIK_BIN=$(find "$ENGINES_DIR" -maxdepth 3 -iname "*pikafish*" -type f 2>/dev/null | grep -v "\.7z\|\.nnue\|\.md" | head -1)
      if [ -n "$PIK_BIN" ]; then
        cp -f "$PIK_BIN" "$ENGINES_DIR/pikafish"
        chmod +x "$ENGINES_DIR/pikafish"
        echo "  ✓ Pikafish installed"
      fi
    fi
  fi
  # Fallback: homebrew on mac
  if [ ! -x "$ENGINES_DIR/pikafish" ] || [ ! -s "$ENGINES_DIR/pikafish" ]; then
    if [ "$OS" = "darwin" ] && command -v brew >/dev/null 2>&1 && brew list pikafish >/dev/null 2>&1; then
      ln -sf "$(brew --prefix pikafish)/bin/pikafish" "$ENGINES_DIR/pikafish"
    fi
  fi
else
  echo "  ✓ Pikafish already present"
fi

# ---------- 2b. Pikafish NNUE ----------
echo ""
echo "[2b/4] Pikafish NNUE eval file (50 MB)"
if [ ! -s "pikafish.nnue" ]; then
  NNUE_URL="https://github.com/official-pikafish/Pikafish/releases/download/Pikafish-2026-01-02/pikafish.nnue"
  if download "$NNUE_URL" "pikafish.nnue"; then
    echo "  ✓ Pikafish NNUE installed"
  fi
else
  echo "  ✓ Pikafish NNUE already present"
fi

# ---------- 3. KataGo ----------
echo ""
echo "[3/4] KataGo v1.18.1 (围棋 / Go)"
if [ ! -x "$ENGINES_DIR/katago" ] || [ ! -s "$ENGINES_DIR/katago" ]; then
  case "$OS-$ARCH" in
    darwin-arm64) KG_URL="https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-macos-Catalina.zip" ;;
    darwin-x86_64) KG_URL="https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-macos-Catalina.zip" ;;
    linux-x86_64) KG_URL="https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-linux-x64.zip" ;;
    linux-aarch64) KG_URL="https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-linux-arm64.zip" ;;
    *)
      echo "  ⚠ no prebuilt KataGo for $OS-$ARCH"
      KG_URL=""
      ;;
  esac
  if [ -n "$KG_URL" ]; then
    KG_ARCHIVE="$ENGINES_DIR/_katago.zip"
    if download "$KG_URL" "$KG_ARCHIVE" && extract "$KG_ARCHIVE" "$ENGINES_DIR"; then
      rm -f "$KG_ARCHIVE"
      KG_BIN=$(find "$ENGINES_DIR" -maxdepth 3 -name "katago" -type f -perm +111 2>/dev/null | head -1)
      if [ -z "$KG_BIN" ]; then
        KG_BIN=$(find "$ENGINES_DIR" -maxdepth 3 -name "katago" -type f 2>/dev/null | grep -v "\.zip\|\.md" | head -1)
      fi
      if [ -n "$KG_BIN" ]; then
        cp -f "$KG_BIN" "$ENGINES_DIR/katago"
        chmod +x "$ENGINES_DIR/katago"
        echo "  ✓ KataGo installed"
      fi
    fi
  fi
  # Fallback: homebrew
  if [ ! -x "$ENGINES_DIR/katago" ] || [ ! -s "$ENGINES_DIR/katago" ]; then
    if [ "$OS" = "darwin" ] && command -v brew >/dev/null 2>&1 && brew list katago >/dev/null 2>&1; then
      ln -sf "$(brew --prefix katago)/bin/katago" "$ENGINES_DIR/katago"
      echo "  ✓ KataGo linked from homebrew"
    fi
  fi
else
  echo "  ✓ KataGo already present"
fi

# ---------- 4. KataGo neural net ----------
echo ""
echo "[4/4] KataGo neural network (~40 MB)"
KG_NETWORK=""
for candidate in \
  "kata1-tf2-b10c384-s2941M-d5872M.bin.gz" \
  "kata1-b18c384nbt-autov2.bin.gz" \
  "kata1-b10c192nbt-adamxantidiag.bin.gz"
do
  if [ -s "$ENGINES_DIR/networks/$candidate" ] || [ -s "$ENGINES_DIR/networks/${candidate%.gz}" ]; then
    echo "  ✓ neural net already present: $candidate"
    KG_NETWORK="$candidate"
    break
  fi
done

if [ -z "$KG_NETWORK" ]; then
  # Try downloading tf2 variant (smaller, what EngineManager expects)
  for url in \
    "https://media.katagotraining.org/uploaded/networks/kata1/kata1-tf2-b10c384-s2941M-d5872M.bin.gz" \
    "https://media.katagotraining.org/uploaded/networks/kata1/kata1-b18c384nbt-autov2.bin.gz"
  do
    name=$(basename "$url")
    if download "$url" "$ENGINES_DIR/networks/$name"; then
      if [[ "$name" == *.gz ]]; then gunzip -f "$ENGINES_DIR/networks/$name"; fi
      KG_NETWORK="$name"
      echo "  ✓ neural net installed: $name"
      break
    fi
  done
fi

echo ""
echo "=================================================="
echo "  Health Check"
echo "=================================================="
bash scripts/check-engines.sh
echo ""
echo "  Tip: if any engine still shows MISSING, run:"
echo "    npm run engines:download"
echo "  then re-check."
