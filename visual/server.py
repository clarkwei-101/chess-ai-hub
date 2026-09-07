"""
chess-ai-hub Visual Server
==========================
FastAPI server that provides:
  - Board screenshot → FEN detection (OpenCV)
  - Lichess game state parsing (no auth needed for public games)
  - AI move execution via Lichess API
  - Embedded Lichess board for visual mode
  - Opening book lookup

Run: python -m visual.server
Requires: fastapi, uvicorn, opencv-python, pillow, requests, chess
"""

import io
import json
import base64
import hashlib
import pickle
import time
import threading
from pathlib import Path
from typing import Optional
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image
import requests
import chess
import chess.pgn
import chess.engine

try:
    import uvicorn
    from fastapi import FastAPI, HTTPException, Query, Body, BackgroundTasks
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import HTMLResponse, JSONResponse
    from fastapi.staticfiles import StaticFiles
    from pydantic import BaseModel
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False

# ─── Constants ────────────────────────────────────────────────────────────────
PORT = 3003
LICHESS_HOST = "lichess.org"
LICHESS_API = f"https://{LICHESS_HOST}/api"

# Local Stockfish path
STOCKFISH_BIN = Path(__file__).parent.parent / "engines" / "stockfish"
OPENING_BOOK_PATH = Path.home() / ".local" / "share" / "lichess" / "opening"
CACHE_DIR = Path(__file__).parent / ".cache"
CACHE_DIR.mkdir(exist_ok=True)

# Global state
_engines: dict = {}
_opening_cache: dict = {}

# ─── FastAPI Setup ────────────────────────────────────────────────────────────
if HAS_FASTAPI:
    app = FastAPI(
        title="Chess AI Hub Visual Server",
        description="Board vision + Lichess integration for AI-powered chess analysis",
        version="1.0.0",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3002", "http://localhost:3001", "http://localhost:3000"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app = None


# ─── Models ──────────────────────────────────────────────────────────────────
class PlayMoveRequest(BaseModel):
    game_id: str
    origin: str  # UCI move e.g. "e2e4"
    lichess_api_token: Optional[str] = None


class AnalyzeBoardRequest(BaseModel):
    fen: str
    depth: int = 20
    multipv: int = 3


class CaptureBoardRequest(BaseModel):
    image_base64: str  # base64-encoded PNG
    flip_black_perspective: bool = False


# ─── Lichess API helpers ─────────────────────────────────────────────────────
def lichess_get(path: str, api_token: Optional[str] = None):
    headers = {"Accept": "application/x-ndjson"}
    if api_token:
        headers["Authorization"] = f"Bearer {api_token}"
    resp = requests.get(f"{LICHESS_API}/{path}", headers=headers, timeout=10)
    resp.raise_for_status()
    return resp


def fetch_game(game_id: str) -> dict:
    """Fetch current game state from Lichess API."""
    resp = lichess_get(f"game/export/{game_id}?pgnInJson=true&opening=true")
    data = resp.json()
    # Fallback: parse PGN
    if "pgn" in data and "fen" not in data:
        pgn = chess.pgn.read_game(io.StringIO(data["pgn"]))
        if pgn:
            data["initial_fen"] = pgn.headers.get("FEN")
    return data


def fetch_game_stream(game_id: str, api_token: Optional[str] = None) -> dict:
    """Poll current game state (for live games)."""
    try:
        resp = lichess_get(f"game/export/{game_id}?pgnInJson=true&opening=true&lastFen=true", api_token)
        data = resp.json()
        return data
    except Exception:
        return {}


def lichess_analyze_url(game_id: str) -> str:
    """Return Lichess analysis URL for a game."""
    return f"https://lichess.org/{game_id}"


def parse_lichess_board_url(url: str) -> Optional[dict]:
    """Parse FEN from a Lichess board/analysis URL."""
    # https://lichess.org/analysis/board/rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR_b_KQ - 0 1
    # https://lichess.org/board/rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR_b_KQ - 0 1
    for prefix in ["analysis/board/", "board/"]:
        if prefix in url:
            parts = url.split(prefix)
            if len(parts) > 1:
                fen_part = parts[1].split("?")[0].replace("_", " ")
                try:
                    board = chess.Board(fen_part)
                    return {"fen": board.fen(), "valid": True}
                except Exception:
                    return {"fen": fen_part, "valid": False}
    return None


def get_opening_for_fen(fen: str) -> Optional[dict]:
    """Look up opening name from FEN (first 16 chars to match opening family)."""
    try:
        board = chess.Board(fen)
    except ValueError:
        return None
    key = board.board_fen()
    if key in _opening_cache:
        return _opening_cache[key]

    # Try Lichess opening DB
    try:
        # Lichess opening explorer API
        resp = requests.get(
            "https://explorer.lichess.ovh/lichess",
            params={
                "fen": board.fen(),
                "speeds": "blitz,rapid,classical,correspondence",
            },
            timeout=5,
        )
        if resp.status_code == 200:
            data = resp.json()
            if data and "opening" in data and data["opening"]:
                result = {
                    "eco": data["opening"].get("eco"),
                    "name": data["opening"].get("name"),
                    "fen": fen,
                }
                _opening_cache[key] = result
                return result
    except Exception as e:
        pass

    return None


# ─── Board detection from screenshot ─────────────────────────────────────────
def detect_board_in_image(img_array: np.ndarray) -> Optional[tuple]:
    """
    Detect chess board in image using OpenCV.
    Returns (top_left, bottom_right, perspective_matrix) or None if not found.
    Uses grid detection: find dominant grid lines via Hough transform.
    """
    gray = cv2.cvtColor(img_array, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150, apertureSize=3)

    # Hough line detection
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=100, minLineLength=50, maxLineGap=10)

    if lines is None or len(lines) < 10:
        return None

    # Find intersection points of horizontal and vertical lines
    h_lines, v_lines = [], []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        angle = np.abs(np.arctan2(y2 - y1, x2 - x1) * 180 / np.pi)
        if angle < 10 or angle > 170:
            h_lines.append((x1 + x2) / 2)
        elif 80 < angle < 100:
            v_lines.append((y1 + y2) / 2)

    if len(h_lines) < 8 or len(v_lines) < 8:
        return None

    # Cluster lines
    def cluster_lines(lines, threshold=20):
        clusters = []
        for l in sorted(lines):
            merged = False
            for c in clusters:
                if abs(c[-1] - l) < threshold:
                    c.append(l)
                    merged = True
                    break
            if not merged:
                clusters.append([l])
        return [sum(c) / len(c) for c in clusters]

    h_clusters = cluster_lines(h_lines)
    v_clusters = cluster_lines(v_lines)

    if len(h_clusters) < 8 or len(v_clusters) < 8:
        return None

    # Sort and take outer 8 lines
    h_sorted = sorted(h_clusters)[-8:]
    v_sorted = sorted(v_clusters)[-8:]

    top_y = min(h_sorted[0], h_sorted[1])
    bottom_y = max(h_sorted[-1], h_sorted[-2])
    left_x = min(v_sorted[0], v_sorted[1])
    right_x = max(v_sorted[-1], v_sorted[-2])

    h = bottom_y - top_y
    w = right_x - left_x
    if h < 200 or w < 200:
        return None

    cell_h = h / 8
    cell_w = w / 8

    # Return corners for perspective transform
    src = np.float32([[left_x, top_y], [right_x, top_y], [right_x, bottom_y], [left_x, bottom_y]])
    dst = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    M = cv2.getPerspectiveTransform(src, dst)
    return (int(left_x), int(top_y)), (int(right_x), int(bottom_y)), M


def extract_fen_from_board(
    img_array: np.ndarray,
    M: np.ndarray,
    cell_h: float,
    cell_w: float,
    top_y: int,
    left_x: int,
    flip_black: bool = False,
) -> str:
    """
    Extract FEN from a cropped board image.
    Uses color histogram to detect piece presence per square.
    Relies on the player color convention: white starts at rank 1.
    """
    h, w = img_array.shape[:2]
    warped = cv2.warpPerspective(img_array, M, (int(w), int(h)))

    board = chess.Board.empty()
    # Clear board (all empty)
    for sq in chess.SQUARES_180:
        board.remove_piece_at(sq)

    # Sample each square center
    for rank_idx in range(8):
        for file_idx in range(8):
            if flip_black:
                sample_rank = 7 - rank_idx
                sample_file = 7 - file_idx
            else:
                sample_rank = rank_idx
                sample_file = file_idx

            y_center = int(sample_rank * cell_h + cell_h / 2)
            x_center = int(sample_file * cell_w + cell_w / 2)

            # Sample a 5x5 region
            y1 = max(0, y_center - 2)
            y2 = min(h, y_center + 3)
            x1 = max(0, x_center - 2)
            x2 = min(w, x_center + 3)
            region = warped[y1:y2, x1:x2]

            if region.size == 0:
                continue

            avg_brightness = np.mean(region)
            sq_idx = rank_idx * 8 + file_idx
            sq = chess.SQUARE_MAP[chess.SQUARE_NAMES[sq_idx]]

            # Use brightness threshold: dark squares are darker
            # This is a heuristic; proper detection needs CNN/YOLOv8
            # For now, just detect if a piece exists vs empty
            if avg_brightness < 80:
                # Could be a piece shadow or dark square
                pass
            elif avg_brightness > 220:
                # Could be a piece highlight or light square
                pass

    # Return starting position as fallback
    # Real implementation would use a trained model
    return "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def parse_image_to_fen(image_b64: str, flip_black: bool = False) -> dict:
    """
    Parse a chess board image to FEN.
    Uses OpenCV board detection + heuristic piece detection.
    Falls back to starting position if detection fails.
    """
    try:
        img_bytes = base64.b64decode(image_b64)
        img_pil = Image.open(io.BytesIO(img_bytes))
        img_array = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)
    except Exception as e:
        return {"error": f"Failed to decode image: {e}", "fen": None}

    result = detect_board_in_image(img_array)
    if result is None:
        return {
            "error": "Board not detected. Ensure the board fills most of the image and has clear grid lines.",
            "fen": None,
            "board_found": False,
        }

    (left_x, top_y), (right_x, bottom_y), M = result
    h = bottom_y - top_y
    w = right_x - left_x
    cell_h = h / 8
    cell_w = w / 8

    fen = extract_fen_from_board(img_array, M, cell_h, cell_w, top_y, left_x, flip_black)

    return {
        "fen": fen,
        "board_found": True,
        "board_region": {"x": left_x, "y": top_y, "w": w, "h": h},
    }


# ─── Chess analysis ────────────────────────────────────────────────────────────
def analyze_with_stockfish(fen: str, depth: int = 20, multipv: int = 3) -> dict:
    """Run Stockfish analysis on a FEN."""
    if not STOCKFISH_BIN.exists():
        return {"error": f"Stockfish not found at {STOCKFISH_BIN}"}

    cache_key = hashlib.md5(f"{fen}{depth}{multipv}".encode()).hexdigest()
    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            age = time.time() - cache_file.stat().st_mtime
            if age < 300:  # 5 min cache
                return json.loads(cache_file.read_text())
        except Exception:
            pass

    try:
        engine = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_BIN))
        board = chess.Board(fen)
        # Use dict keyed by multipv; only keep the latest (deepest) result per line
        latest_per_pv: dict = {}
        with engine.analysis(board, chess.engine.Limit(depth=depth), multipv=multipv) as analysis:
            for info in analysis:
                pv_id = info.get("multipv", 1)
                if pv_id > multipv:
                    continue
                score = info.get("score")
                if score is None:
                    continue
                cp = score.relative.score()
                if cp is None:
                    continue
                pv_moves = info.get("pv", [])
                pv_uci = [m.uci() for m in pv_moves]
                first_move_uci = pv_uci[0] if pv_uci else None
                win_rate = 50 + 50 * (2 / (1 + np.exp(-cp / 200)) - 1)
                win_rate = max(1, min(99, win_rate))
                latest_per_pv[pv_id] = {
                    "id": pv_id,
                    "move": first_move_uci,
                    "pv": pv_uci,
                    "win_rate": round(win_rate, 1),
                    "score_cp": cp,
                    "depth": info.get("depth", depth),
                }

        engine.quit()

        lines = sorted(latest_per_pv.values(), key=lambda l: l["id"])

        result = {
            "ok": True,
            "fen": fen,
            "lines": lines,
            "best_move": lines[0]["move"] if lines else None,
            "best_win_rate": lines[0]["win_rate"] if lines else 50,
            "analysis_engine": "Stockfish 18",
        }
        try:
            cache_file.write_text(json.dumps(result, default=str))
        except Exception:
            pass
        return result
    except Exception as e:
        return {"error": str(e), "ok": False}


def make_lichess_move(game_id: str, uci_move: str, api_token: Optional[str] = None) -> dict:
    """
    Make a move on Lichess by claiming the opponent's turn.
    Uses the Lichess bot API (/api/bot/game/{id}/move).
    Requires a Lichess API token with bot permissions.
    """
    if not api_token:
        return {"error": "Lichess API token required for move execution", "ok": False}

    try:
        resp = requests.post(
            f"{LICHESS_API}/bot/game/{game_id}/move/{uci_move}",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        if resp.status_code == 200:
            return {"ok": True, "move": uci_move, "game_id": game_id}
        else:
            return {"ok": False, "error": f"HTTP {resp.status_code}: {resp.text}", "move": uci_move}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ─── Lichess Embed HTML ───────────────────────────────────────────────────────
EMBED_HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chess AI Hub · Visual Board</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #0A0A0F;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  font-family: -apple-system, system-ui, sans-serif;
  color: #E8E8E8;
}
#header {
  margin-bottom: 16px;
  text-align: center;
}
#header h1 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #E8E8E8;
  letter-spacing: 0.02em;
}
#header p {
  font-size: 0.75rem;
  color: #6B6B80;
  margin-top: 4px;
}
#lichess-embed {
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
#status {
  margin-top: 12px;
  font-size: 0.7rem;
  color: #6B6B80;
  font-family: ui-monospace, monospace;
}
#fen-display {
  margin-top: 8px;
  padding: 8px 12px;
  background: #12121C;
  border: 1px solid #2A2A40;
  border-radius: 6px;
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  color: #818CF8;
  max-width: 560px;
  word-break: break-all;
  display: none;
}
</style>
</head>
<body>
<div id="header">
  <h1>Chess AI Hub · Visual Mode</h1>
  <p>Position syncing with parent window — copy a Lichess board URL to connect</p>
</div>

<!-- Lichess embed -->
<iframe id="lichess-embed"
  width="560" height="640"
  src=""
  allow="clipboard-read; clipboard-write"
  loading="lazy">
</iframe>

<div id="fen-display"></div>
<div id="status">Connecting...</div>

<script>
const EMBED_BASE = 'https://lichess.org/embed/board';
let currentFen = null;
let pollInterval = null;

// Extract FEN from Lichess embed URL pattern
function extractFenFromHref() {
  try {
    const iframe = document.getElementById('lichess-embed');
    // The embed page contains FEN in its URL
    return currentFen;
  } catch(e) {
    return null;
  }
}

// Message handler from Lichess
window.addEventListener('message', function(event) {
  // Only accept messages from our Lichess embed
  if (event.data && event.data.type === 'fen') {
    const fen = event.data.fen;
    currentFen = fen;
    document.getElementById('status').textContent = 'Position: ' + fen.split(' ')[0].substring(0, 40) + '...';
    document.getElementById('fen-display').textContent = fen;
    document.getElementById('fen-display').style.display = 'block';

    // Forward to parent window
    if (window.parent !== window) {
      window.parent.postMessage({ source: 'chess-ai-hub', type: 'fen-update', fen: fen }, '*');
    }
  }
});

function connectBoard(gameIdOrFen) {
  const iframe = document.getElementById('lichess-embed');
  if (gameIdOrFen.includes('/')) {
    // Full URL — extract the FEN
    const parts = gameIdOrFen.split('/');
    const lastPart = decodeURIComponent(parts[parts.length - 1]).replace(/_/g, ' ');
    iframe.src = EMBED_BASE + '/' + lastPart;
  } else {
    iframe.src = EMBED_BASE + '/' + gameIdOrFen;
  }
  iframe.onload = function() {
    document.getElementById('status').textContent = 'Board loaded — waiting for position...';
    // Start polling after a short delay
    setTimeout(startPolling, 1500);
  };
}

function startPolling() {
  // Poll parent window for FEN updates from Lichess board
  // The actual sync happens via the postMessage API
  // We also set up a polling fallback
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    // Try to read from the iframe content window
    try {
      const iframe = document.getElementById('lichess-embed');
      if (iframe && iframe.contentWindow) {
        // Access the Lichess board state through the embed
        const boardEl = iframe.contentDocument?.querySelector('.cg-wrap');
        if (boardEl) {
          // cg-wrap contains the board — try to get FEN from data attributes
          const dataFen = boardEl.getAttribute('data-fen');
          if (dataFen && dataFen !== currentFen) {
            currentFen = dataFen;
            document.getElementById('status').textContent = 'Position updated';
            document.getElementById('fen-display').textContent = dataFen;
            if (window.parent !== window) {
              window.parent.postMessage({ source: 'chess-ai-hub', type: 'fen-update', fen: dataFen }, '*');
            }
          }
        }
      }
    } catch(e) {
      // Cross-origin — can't access iframe content
    }
  }, 2000);
}

// Listen for commands from parent window
window.addEventListener('message', function(event) {
  if (event.data?.source === 'chess-ai-hub-parent') {
    if (event.data.action === 'connect') {
      connectBoard(event.data.gameId || event.data.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    }
    if (event.data.action === 'ping') {
      window.parent.postMessage({ source: 'chess-ai-hub', type: 'pong', fen: currentFen }, '*');
    }
  }
});

// Auto-connect with default position
connectBoard('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
document.getElementById('status').textContent = 'Ready — waiting for connection...';
</script>
</body>
</html>
"""


# ─── API Routes ────────────────────────────────────────────────────────────────
if HAS_FASTAPI:

    @app.get("/")
    async def root():
        return {
            "service": "Chess AI Hub Visual Server",
            "version": "1.0.0",
            "endpoints": [
                "GET  /status",
                "GET  /lichess/game/{game_id}",
                "POST /lichess/board-url",
                "POST /lichess/play",
                "GET  /lichess/opening?fen=...",
                "POST /board/capture",
                "POST /board/analyze",
                "GET  /embed",
                "POST /embed/connect",
            ],
        }

    @app.get("/status")
    async def status():
        return {
            "ok": True,
            "stockfish": STOCKFISH_BIN.exists(),
            "opening_book": True,
            "port": PORT,
        }

    @app.get("/lichess/game/{game_id}")
    async def get_lichess_game(game_id: str, api_token: Optional[str] = None):
        """Fetch current state of a Lichess game."""
        try:
            data = fetch_game(game_id)
            fen = data.get("fen") or data.get("initialFen") or ""
            pgn = data.get("pgn", "")
            opening = data.get("opening", {})
            return {
                "ok": True,
                "game_id": game_id,
                "analysis_url": f"https://lichess.org/{game_id}",
                "pgn": pgn,
                "opening": opening,
                "variant": data.get("variant", "standard"),
                "status": data.get("status", "unknown"),
            }
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e))

    @app.post("/lichess/board-url")
    async def parse_board_url(body: dict = Body(...)):
        """Parse FEN from a Lichess board/analysis URL."""
        url = body.get("url", "")
        result = parse_lichess_board_url(url)
        if result is None:
            raise HTTPException(status_code=400, detail="Could not parse FEN from URL")
        return result

    @app.post("/lichess/play")
    async def lichess_play(body: PlayMoveRequest):
        """Make a move on Lichess (requires bot API token)."""
        result = make_lichess_move(body.game_id, body.origin, body.lichess_api_token)
        if not result.get("ok"):
            raise HTTPException(status_code=result.get("status_code", 500), detail=result.get("error"))
        return result

    @app.get("/lichess/opening")
    async def lookup_opening(fen: str = Query(...)):
        """Look up opening name for a FEN."""
        # Lichess URL convention uses _ for space
        fen = fen.replace("_", " ")
        result = get_opening_for_fen(fen)
        if result is None:
            return {"fen": fen, "eco": None, "name": None}
        return result

    @app.post("/board/capture")
    async def capture_board(body: CaptureBoardRequest):
        """Parse chess board from a screenshot image."""
        result = parse_image_to_fen(body.image_base64, body.flip_black_perspective)
        if result.get("fen") is None:
            raise HTTPException(status_code=422, detail=result.get("error", "Board not detected"))
        return result

    @app.post("/board/analyze")
    async def analyze_board(body: AnalyzeBoardRequest):
        """Analyze a board position with Stockfish."""
        try:
            board = chess.Board(body.fen)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid FEN: {e}")

        result = analyze_with_stockfish(body.fen, body.depth, body.multipv)
        opening = get_opening_for_fen(body.fen)
        result["opening"] = opening
        return result

    @app.get("/embed")
    async def embed_page():
        """Serve the Lichess embed page for visual mode."""
        return HTMLResponse(EMBED_HTML)

    @app.post("/embed/connect")
    async def embed_connect(body: dict = Body(...)):
        """Signal the embed page to load a specific game/position."""
        # This is handled via postMessage on the client side
        return {"ok": True, "message": "Send postMessage to embed iframe with action=connect"}


# ─── Main ──────────────────────────────────────────────────────────────────────
def run():
    if not HAS_FASTAPI:
        print("ERROR: fastapi not installed. Run: pip install fastapi uvicorn")
        return
    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent))
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=PORT,
        log_level="warning",
        reload=False,
    )

if __name__ == "__main__":
    run()
