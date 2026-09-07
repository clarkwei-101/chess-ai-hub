#!/usr/bin/env python3
"""
Go AI Server — Chess AI Hub
Wraps KataGo with:
  1. Opening book (from SGF files)
  2. Style knowledge base (徐莹 / 李世乭 / 柯洁 etc.)
  3. KataGo enhanced parameters (8000+ visits)
  4. Style-prior reranking

HTTP API:
  POST /move
    body: { moves: ["D4","Q16",...], style: "xu-ying", color: "B" }
    returns: { move: "D16", source: "style|engine|book", confidence: 0.85 }

  GET /health
    returns: { ok: true, katago: true, networks_loaded: true }

  GET /openings/{style}
    returns: { style, opening_count, samples: [...] }
"""

import asyncio
import json
import os
import re
import socket
import struct
import subprocess
import sys
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
# go-ai-server.py is at: lib/go-ai-server/go_ai_server.py
# project root is 2 levels up
PROJECT_ROOT = SCRIPT_DIR.parent.parent
GO_KNOWLEDGE_DIR = PROJECT_ROOT / "go-knowledge"
SGF_DIR = GO_KNOWLEDGE_DIR / "chinese/games"
XIANGQI_KNOWLEDGE_DIR = PROJECT_ROOT / "xiangqi-knowledge/chinese"
KATAGO_BIN = "/opt/homebrew/bin/katago"
MODEL_PATH = str(PROJECT_ROOT / "engines/networks/kata1-tf2-b10c384-s2941M-d5872M.bin.gz")
CFG_PATH = str(PROJECT_ROOT / "engines/gtp.cfg")
STYLE_CACHE = PROJECT_ROOT / ".style-cache"

# All Go SGF directories (one per language/region)
SGF_DIRS: list[Path] = [
    GO_KNOWLEDGE_DIR / "chinese/games",
    GO_KNOWLEDGE_DIR / "japanese/games",
    GO_KNOWLEDGE_DIR / "korean/games",
]

# ── Style profiles ──────────────────────────────────────────────────────────
# Maps styleId → (sgf player names to match — handle both English and Chinese)
STYLE_PLAYERS: dict[str, list[str]] = {
    "xu-ying":    ["Xu Ying", "xu ying", "ying xu", "YING", "XU YING", "徐莹"],
    "lee-sedol":   ["Lee Sedol", "lee sedol", "sedol lee", "SEDOL", "李世乭"],
    "ke-jie":      ["Ke Jie", "ke jie", "jie ke", "KE JIE", "柯洁"],
    "lee-changho": ["Lee Changho", "lee changho", "changho lee", "CHANGHO", "李昌鎬"],
    "shin-jinseo": ["Shin Jinseo", "shin jinseo", "jinseo shin", "申真谞"],
    "go-seigen":   ["Go Seigen", "go seigen", "seigen go", "Wu Qingyuan", "wu qingyuan", "吳清源"],
    "gu-li":       ["Gu Li", "gu li", "li gu", "古力"],
    "mi-yuting":   ["Mi Yuting", "mi yuting", "yuting mi", "yuting", "Mei Yuting", "芈昱廷"],
    "yang-dingxin": ["Yang Dingxin", "yang dingxin", "dingxin yang", "杨鼎新"],
    "chang-hao":   ["Chang Hao", "chang hao", "hao chang", "常昊"],
}

# GTP vertex (SGF "cc" etc.) → (col 0-indexed, row 0-indexed)
def sgf_to_coord(sgf: str) -> tuple[int, int] | None:
    if not sgf or sgf.lower() in ("pass", "tt"):
        return None
    if len(sgf) < 2:
        return None
    col_char = sgf[0].upper()
    if col_char == "I":
        return None  # no I column
    col = ord(col_char) - ord("A")
    if col_char > "I":
        col -= 1
    try:
        row = int(sgf[1:]) - 1
    except ValueError:
        return None
    if row < 0 or row >= 19 or col < 0 or col >= 19:
        return None
    return (col, row)

def coord_to_gtp(col: int, row: int) -> str:
    """0-indexed col/row → GTP vertex like 'D4'"""
    if col < 0 or row < 0:
        return "pass"
    col_char = chr(ord("A") + col + (1 if col >= 8 else 0))
    return f"{col_char}{row + 1}"

def sgf_letter_to_num(c: str) -> int:
    """SGF letter to 1-indexed number (a=1, b=2, ..., i=9 SKIP, j=10, ..., t=20).
    Used for both column and row in the letter-based SGF format."""
    c = c.lower()
    n = ord(c) - ord('a') + 1  # a=1, b=2, ..., t=20
    if n > 9:  # skip i (9th letter)
        n -= 1
    return n  # 1-19 for 19x19 board

def num_to_gtp_letter(n: int) -> str:
    """Convert 1-19 SGF column/row number to GTP letter (a=1 ... t=19, skip i)."""
    idx = n  # 1-19
    if idx > 9:  # skip i
        idx += 1
    return chr(ord('a') + idx - 1)

def sgf_to_gtp(sgf: str) -> str:
    """
    Convert SGF vertex (letter-based format) to GTP vertex.

    SGF letter-based: col=letter(a=1 LEFT, t=19 RIGHT), row=letter(a=1 TOP, s=19 BOTTOM), skip i=9.
    GTP:            col=letter(A=1 LEFT, T=19 RIGHT, skip I), row=NUMBER(1=BOTTOM, 19=TOP).

    Conversion: GTP col = same letter, GTP row = 20 - SGF row (1-indexed).
    Example: SGF 'pp' = col 16, row 16 → GTP 'p4' (col P, row 4 from bottom)
             SGF 'dd' = col 4,  row 4  → GTP 'd16' (col D, row 16 from bottom)
             SGF 'pd' = col 16, row 4  → GTP 'p16' (col P, row 16 from bottom)
    """
    if not sgf or sgf.lower() in ("pass", "tt"):
        return "pass"
    sgf = sgf.lower()
    if len(sgf) < 2:
        return "pass"
    try:
        sgf_col_num = sgf_letter_to_num(sgf[0])  # 1-19
        sgf_row_num = sgf_letter_to_num(sgf[1])  # 1-19 (1 = top)
    except (ValueError, TypeError):
        return "pass"
    # GTP column: same letter (a→A, d→D, etc.)
    gtp_col_letter = num_to_gtp_letter(sgf_col_num)
    # GTP row: inverted (1 = bottom, 19 = top)
    gtp_row_num = 20 - sgf_row_num
    if gtp_row_num < 1 or gtp_row_num > 19:
        return "pass"
    return f"{gtp_col_letter}{gtp_row_num}"

# ── SGF Parser ─────────────────────────────────────────────────────────────
def parse_sgf_raw(body: str) -> dict:
    """Parse SGF body to {prop: value} dict. Supports multi-char props like PB/PW/B/W."""
    result = {}
    # Match property identifiers (multi-char first: PB/PW/AB/AW, then single: B/W/P/L/M)
    # Property name is directly before '[', value is everything up to ']'.
    for m in re.finditer(r'([A-Za-z]+)\[([^\]]*)\]', body):
        key = m.group(1)
        val = m.group(2)
        if key in result:
            if not isinstance(result[key], list):
                result[key] = [result[key]]
            result[key].append(val)
        else:
            result[key] = val
    return result

def get_sgf_moves(body: str) -> list[tuple[str, str]]:
    """Extract (color, vertex) pairs from SGF body.
    Handles both SGF styles:
    - `;B[dd];W[pp]` (Go coordinates: col letter + row number)
    - `;B[D4];W[E5]` (alternative? not typically in Go SGF)
    Returns: list of (color, vertex) where vertex is the raw SGF value.
    """
    moves = []
    for m in re.finditer(r';([BW])\[([a-zA-Z0-9]+)\]', body):
        color = m.group(1)
        val = m.group(2).lower()
        if val in ("tt", "pass"):
            val = "pass"
        moves.append((color, val))
    return moves

def get_sgf_player_names(props: dict) -> tuple[str, str]:
    black = props.get("PB", props.get("AB", ""))
    white = props.get("PW", props.get("AW", ""))
    return (black.strip(), white.strip())

def get_sgf_result(props: dict) -> str:
    """Return 'B', 'W', or '?'."""
    re_val = props.get("RE", "")
    if re_val.upper().startswith("B"):
        return "B"
    if re_val.upper().startswith("W"):
        return "W"
    return "?"

# ── Style Knowledge Base ────────────────────────────────────────────────────
@dataclass
class StyleMove:
    move: str           # GTP vertex
    count: int
    wins: int
    games: int
    confidence: float   # 0-1

@dataclass
class StyleKB:
    style_id: str
    player_names: list[str]
    # position_key → list of StyleMove
    transitions: dict[str, list[StyleMove]] = field(default_factory=dict)
    # opening sequences: first N moves → win rate
    opening_stats: dict[str, tuple[int, int]] = field(default_factory=dict)  # seq → (wins, total)
    total_games: int = 0
    loaded: bool = False

    def lookup(self, position_moves: list[str], side: str) -> Optional[StyleMove]:
        """Find style move for current position. Returns None if no data."""
        key = self._make_key(position_moves, side)
        candidates = self.transitions.get(key, [])
        if not candidates:
            return None
        # Return most frequent move
        return max(candidates, key=lambda m: m.count)

    def _make_key(self, moves: list[str], side: str, depth: int = 6) -> str:
        recent = moves[-depth:] if len(moves) >= depth else moves
        return f"{' '.join(recent)}|{side}"

class StyleKnowledgeBase:
    """Loads and caches style knowledge from SGF files."""

    def __init__(self):
        self.styles: dict[str, StyleKB] = {}
        self._lock = threading.Lock()
        self._loaded = False

    def ensure_loaded(self):
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            self._do_load()
            self._loaded = True

    def _do_load(self):
        """Build style knowledge bases from all SGF files."""
        for style_id, player_names in STYLE_PLAYERS.items():
            self._load_style(style_id, player_names)

    def _load_style(self, style_id: str, player_names: list[str]):
        kb = StyleKB(style_id=style_id, player_names=player_names)

        # Search all SGF directories (chinese / japanese / korean)
        all_files: list[Path] = []
        for d in SGF_DIRS:
            if d.exists():
                all_files.extend(d.glob("*.sgf"))
        if not all_files:
            print(f"[StyleKB] No SGF files found in: {[str(d) for d in SGF_DIRS]}")
            return

        # Collect matching games
        transition_map: dict[str, list[dict]] = defaultdict(list)
        opening_map: dict[str, list[str]] = defaultdict(list)  # seq → results

        for sgf_file in all_files:
            try:
                body = sgf_file.read_text(encoding="utf-8", errors="ignore")
                props = parse_sgf_raw(body)
                black, white = get_sgf_player_names(props)
                result = get_sgf_result(props)

                # Check if this player is in the game
                is_black = any(n.lower() in black.lower() for n in player_names)
                is_white = any(n.lower() in white.lower() for n in player_names)
                if not is_black and not is_white:
                    continue

                player_side = "B" if is_black else "W"
                moves = get_sgf_moves(body)
                if not moves:
                    continue

                kb.total_games += 1
                game_moves = [sgf_to_gtp(m[1]) for m in moves]  # GTP format

                # Opening stats (first 8 moves)
                if len(game_moves) >= 4:
                    seq_key = " ".join(game_moves[:8])
                    opening_map[seq_key].append(result)

                # Move transitions (store in GTP format)
                for i, (color, raw_move) in enumerate(moves):
                    if color != player_side:
                        continue
                    side_at_move = "B" if i % 2 == 0 else "W"
                    key_moves = game_moves[:i]
                    key = kb._make_key(key_moves, side_at_move)
                    gtp_move = sgf_to_gtp(raw_move)  # convert to GTP
                    transition_map[key].append({
                        "move": gtp_move,
                        "win": 1 if result == player_side else 0,
                    })

            except Exception as e:
                print(f"[StyleKB] Error parsing {sgf_file}: {e}")
                continue

        # Build transitions
        for key, entries in transition_map.items():
            move_counts: dict[str, dict] = defaultdict(lambda: {"count": 0, "wins": 0, "games": set()})
            for e in entries:
                mv = e["move"]
                move_counts[mv]["count"] += 1
                move_counts[mv]["wins"] += e["win"]
                move_counts[mv]["games"].add(id(e))  # rough dedup

            style_moves = []
            for mv, data in move_counts.items():
                confidence = min(1.0, data["count"] / 3.0)
                style_moves.append(StyleMove(
                    move=mv,
                    count=data["count"],
                    wins=data["wins"],
                    games=len(data["games"]),
                    confidence=confidence,
                ))
            style_moves.sort(key=lambda m: m.count, reverse=True)
            kb.transitions[key] = style_moves

        # Build opening stats
        for seq, results in opening_map.items():
            wins = sum(1 for r in results if r == "B")
            kb.opening_stats[seq] = (wins, len(results))

        kb.loaded = True
        self.styles[style_id] = kb
        print(f"[StyleKB] Loaded {style_id}: {kb.total_games} games, {len(kb.transitions)} positions")

    def lookup(self, style_id: str, moves: list[str], side: str) -> Optional[StyleMove]:
        self.ensure_loaded()
        kb = self.styles.get(style_id)
        if not kb or not kb.loaded:
            return None
        return kb.lookup(moves, side)

# ── Opening Book ───────────────────────────────────────────────────────────
@dataclass
class BookEntry:
    move: str
    games: int
    wins: int
    win_rate: float

class OpeningBook:
    """Fast opening book from all SGF files (chinese / japanese / korean)."""

    def __init__(self, sgf_dirs: list[Path]):
        self.sgf_dirs = sgf_dirs
        self.entries: dict[str, list[BookEntry]] = defaultdict(list)
        self._lock = threading.Lock()
        self._loaded = False

    def ensure_loaded(self):
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            self._do_load()
            self._loaded = True

    def _do_load(self):
        all_files: list[Path] = []
        for d in self.sgf_dirs:
            if d.exists():
                all_files.extend(d.glob("*.sgf"))
        if not all_files:
            print(f"[OpeningBook] No SGF files found in: {[str(d) for d in self.sgf_dirs]}")
            return
        count = 0
        for sgf_file in all_files:
            try:
                body = sgf_file.read_text(encoding="utf-8", errors="ignore")
                props = parse_sgf_raw(body)
                result = get_sgf_result(props)
                moves = get_sgf_moves(body)
                if len(moves) < 2:
                    continue

                # First 12 moves as key (convert SGF → GTP)
                first_moves = [sgf_to_gtp(m[1]) for m in moves[:12]]
                key = " ".join(first_moves)
                if len(moves) > 0:
                    first_move = sgf_to_gtp(moves[0][1])  # first move by B, SGF → GTP
                    if first_move.lower() not in ("pass", "tt"):
                        self.entries[key].append(BookEntry(
                            move=first_move,
                            games=1,
                            wins=1 if result == "B" else 0,
                            win_rate=1.0 if result == "B" else 0.0,
                        ))
                count += 1
            except Exception:
                continue
        # Aggregate
        for key, entries_list in self.entries.items():
            agg: dict[str, dict] = defaultdict(lambda: {"games": 0, "wins": 0})
            for e in entries_list:
                agg[e.move]["games"] += 1
                agg[e.move]["wins"] += e.wins
            self.entries[key] = [
                BookEntry(
                    move=mv,
                    games=d["games"],
                    wins=d["wins"],
                    win_rate=d["wins"] / d["games"] if d["games"] > 0 else 0,
                )
                for mv, d in agg.items()
            ]
        print(f"[OpeningBook] Loaded {count} games, {len(self.entries)} opening keys")

    def lookup(self, moves: list[str], depth: int = 12) -> Optional[BookEntry]:
        self.ensure_loaded()
        if not moves:
            return None
        first_moves = moves[:depth]
        key = " ".join(first_moves)
        candidates = self.entries.get(key, [])
        if not candidates:
            return None
        return max(candidates, key=lambda e: e.games)

# ── KataGo Subprocess Manager ──────────────────────────────────────────────
class KataGoManager:
    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self.lock = threading.Lock()
        self._startup_done = False
        self.pending: dict[int, tuple[asyncio.Future, str]] = {}
        self.cmd_id = 0
        self.reader_task: Optional[threading.Thread] = None
        self._running = False

    def start(self):
        with self.lock:
            if self.proc and self.proc.poll() is None:
                return
        env = dict(os.environ)
        env.pop("LD_LIBRARY_PATH", None)
        self.proc = subprocess.Popen(
            [KATAGO_BIN, "gtp", "-model", MODEL_PATH, "-config", CFG_PATH],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=str(PROJECT_ROOT),
        )
        self._running = True
        self._startup_done = False
        threading.Thread(target=self._read_loop, daemon=True).start()
        # Wait for GTP ready
        self._send("boardsize 19")
        self._send("clear_board")
        self._send("komi 7.5")
        self._send("kata-set-rules chinese")
        time.sleep(0.5)
        self._startup_done = True
        print("[KataGo] Started")

    def _read_loop(self):
        """Read GTP responses in background thread."""
        proc = self.proc
        if not proc or not proc.stdout:
            return
        buf = ""
        while self._running and proc.poll() is None:
            try:
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                buf += chunk.decode("utf-8", errors="replace")
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    self._handle_line(line)
            except Exception as e:
                print(f"[KataGo reader error] {e}")
                break

    def _handle_line(self, line: str):
        # GTP response: = <id> <payload> or = <payload>
        m = re.match(r"^(?:=(\d+)\s*)?(.+)$", line)
        if not m:
            return
        cmd_id_str = m.group(1) or ""
        payload = m.group(2).strip()
        if cmd_id_str:
            cid = int(cmd_id_str)
            fut, _ = self.pending.pop(cid, (None, ""))
            if fut and not fut.done():
                fut.set_result(payload)

    def _send(self, cmd: str) -> str:
        """Send GTP command synchronously and wait for response."""
        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                raise RuntimeError("KataGo not running")
            cid = self.cmd_id
            self.cmd_id += 1
            fut: asyncio.Future = asyncio.Future()
            self.pending[cid] = (fut, cmd)
        full_cmd = f"{cid} {cmd}" if cid > 0 else cmd
        self.proc.stdin.write((full_cmd + "\n").encode())
        self.proc.stdin.flush()
        try:
            return asyncio.run(asyncio.wait_for(fut, timeout=30.0))
        except asyncio.TimeoutError:
            with self.lock:
                self.pending.pop(cid, None)
            return "?"

    def play(self, color: str, vertex: str) -> str:
        """Play a stone."""
        if vertex.lower() == "pass":
            return self._send(f"play {color} pass")
        return self._send(f"play {color} {vertex}")

    def genmove(self, color: str, time_ms: int = 30000) -> str:
        """Generate a move. Returns GTP vertex or 'pass'."""
        result = self._send(f"genmove {color}")
        result = result.strip().split()[0] if result else "pass"
        return result.lower()

    def analyze(self, color: str, visits: int = 8000) -> dict:
        """Get analysis via kata-analyze. Returns top moves."""
        # Use kata-analyze with wide visits
        resp = self._send(f"kata-analyze {color} 1000 rules chinese maxVisits {visits}")
        # Parse the last info line
        info = self._parse_analyze_line(resp)
        return info

    def _parse_analyze_line(self, line: str) -> dict:
        """Parse kata-analyze info line into structured data."""
        # Format: info move D4 visits 1500 winrate 0.52 scoreLead 1.5 policy 0.08 pv D4 Q16 ...
        result = {"move": None, "winrate": 0.5, "score_lead": 0.0, "policy": 0.0, "pv": []}
        parts = line.split()
        i = 0
        while i < len(parts):
            k = parts[i]
            if k == "move" and i + 1 < len(parts):
                result["move"] = parts[i + 1]
                i += 2
            elif k == "winrate" and i + 1 < len(parts):
                try:
                    result["winrate"] = float(parts[i + 1])
                except ValueError:
                    pass
                i += 2
            elif k == "scoreLead" and i + 1 < len(parts):
                try:
                    result["score_lead"] = float(parts[i + 1])
                except ValueError:
                    pass
                i += 2
            elif k == "policy" and i + 1 < len(parts):
                try:
                    result["policy"] = float(parts[i + 1])
                except ValueError:
                    pass
                i += 2
            elif k == "pv" and i + 1 < len(parts):
                result["pv"] = parts[i + 1:]
                i += 1 + len(result["pv"])
            else:
                i += 1
        return result

    def new_game(self):
        """Reset board."""
        self._send("clear_board")
        self._send("komi 7.5")
        self._send("kata-set-rules chinese")

    def stop(self):
        self._running = False
        with self.lock:
            if self.proc:
                try:
                    self.proc.stdin.write(b"quit\n")
                    self.proc.stdin.flush()
                except Exception:
                    pass
                try:
                    self.proc.terminate()
                    self.proc.wait(timeout=5)
                except Exception:
                    pass
                self.proc = None

# ── Go AI Core ─────────────────────────────────────────────────────────────
class GoAI:
    def __init__(self):
        self.katago = KataGoManager()
        self.style_kb = StyleKnowledgeBase()
        self.opening_book = OpeningBook(SGF_DIRS)
        self._board_moves: list[str] = []  # GTP vertices in order
        self._current_color = "B"
        self._lock = threading.Lock()

    def start(self):
        self.katago.start()
        self.style_kb.ensure_loaded()
        self.opening_book.ensure_loaded()

    def reset(self):
        with self._lock:
            self.katago.new_game()
            self._board_moves = []
            self._current_color = "B"

    def play_move(self, vertex: str, color: str):
        """Apply a move to the internal board state."""
        with self._lock:
            self._board_moves.append(vertex)
            self._current_color = "W" if color == "B" else "B"

    def get_best_move(self, style: str, color: str, time_ms: int = 30000) -> dict:
        """
        Main AI decision:
        1. Opening book check (first 20 moves)
        2. Style knowledge lookup
        3. KataGo with style priors
        4. Return best move
        """
        with self._lock:
            board_moves = list(self._board_moves)

        # 1. Opening book
        if len(board_moves) < 20:
            book_move = self.opening_book.lookup(board_moves)
            if book_move and book_move.games >= 3:
                return {
                    "move": book_move.move,
                    "source": "book",
                    "confidence": min(1.0, book_move.games / 10.0),
                    "book_stats": {"games": book_move.games, "win_rate": book_move.win_rate},
                }

        # 2. Style knowledge
        style_move = self.style_kb.lookup(style, board_moves, color)
        style_move_confidence = 0.0
        style_move_vertex = None
        if style_move and style_move.count >= 2:
            style_move_vertex = style_move.move
            style_move_confidence = style_move.confidence

        # 3. KataGo analysis
        # Get top 5 candidates
        try:
            analysis = self.katago.analyze(color, visits=8000)
        except Exception as e:
            print(f"[GoAI] KataGo analyze error: {e}")
            analysis = {}

        katago_move = analysis.get("move", None) or "pass"
        katago_winrate = analysis.get("winrate", 0.5)
        katago_policy = analysis.get("policy", 0.0)

        # 4. Style-aware reranking
        if style_move_vertex and style_move_vertex != katago_move:
            # If style move is in top-3 KataGo candidates, boost it
            # For now, if style confidence is high (> 0.5), prefer style move
            if style_move_confidence >= 0.6:
                return {
                    "move": style_move_vertex,
                    "source": "style",
                    "confidence": style_move_confidence,
                    "katago_move": katago_move,
                    "katago_winrate": katago_winrate,
                }

        # 5. Default: KataGo's choice
        return {
            "move": katago_move,
            "source": "engine",
            "confidence": katago_policy,
            "style_move_available": style_move_vertex,
            "style_confidence": style_move_confidence,
            "katago_winrate": katago_winrate,
        }

    def stop(self):
        self.katago.stop()

# ── HTTP Server (using built-in http.server) ───────────────────────────────
import http.server
import urllib.parse

# Global AI instance
go_ai = GoAI()

class GoAIHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[HTTP] {args[0]}")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self.send_json({"ok": True, "katago": go_ai.katago.proc is not None})
        elif parsed.path.startswith("/openings/"):
            style = parsed.path.split("/")[-1]
            kb = go_ai.style_kb.styles.get(style)
            if not kb:
                self.send_json({"error": "style not found"}, status=404)
                return
            samples = list(kb.opening_stats.items())[:10]
            self.send_json({
                "style": style,
                "total_games": kb.total_games,
                "position_count": len(kb.transitions),
                "samples": [{"seq": s, "win_rate": w/t} for s, (w, t) in samples],
            })
        else:
            self.send_json({"error": "not found"}, status=404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/move":
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                data = json.loads(body)
            except Exception as e:
                self.send_json({"error": str(e)}, status=400)
                return

            moves = data.get("moves", [])
            style = data.get("style", "default")
            color = data.get("color", "B")
            time_ms = data.get("time_ms", 30000)

            result = go_ai.get_best_move(style, color, time_ms)
            self.send_json(result)
        elif parsed.path == "/reset":
            go_ai.reset()
            self.send_json({"ok": True})
        else:
            self.send_json({"error": "not found"}, status=404)

    def send_json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

def run_server(port: int = 8200):
    # Start KataGo
    print("[GoAI] Initializing...")
    try:
        go_ai.start()
    except Exception as e:
        print(f"[GoAI] Startup error: {e}")
        sys.exit(1)

    # HTTP server
    server = http.server.HTTPServer(("127.0.0.1", port), GoAIHandler)
    print(f"[GoAI] Server running on http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        go_ai.stop()
        server.shutdown()

if __name__ == "__main__":
    run_server()
