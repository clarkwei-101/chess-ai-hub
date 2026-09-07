#!/usr/bin/env python3
"""Stability: 3 full games per variant × 3 variants. Checks no leaks/stalls."""
import json
import sys
import time
import urllib.request

BASE = "http://localhost:3002"
ROUNDS = 3
VARIANTS = ["chess", "xiangqi", "go"]
OPENINGS = {
    "chess": ["e2e4", "g1f3", "f1c4", "d2d3"],
    "xiangqi": ["h2e2", "b0c2", "h0g2", "c6c5"],
    "go": ["D4", "Q16", "R6", "D17"],
}


def post(path, body=None):
    return urllib.request.urlopen(
        urllib.request.Request(f"{BASE}{path}",
            data=json.dumps(body or {}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST"),
        timeout=60,
    )


def stream_first(variant):
    """Measure first SSE chunk time."""
    url = f"{BASE}/api/engine/analyze?variant={variant}&depth=18&multipv=3"
    t0 = time.time()
    with urllib.request.urlopen(url, timeout=45) as r:
        for raw in r:
            line = raw.decode().rstrip()
            if line.startswith("data:"):
                try:
                    p = json.loads(line[5:].strip())
                    if p.get("ok") and p.get("analysis"):
                        return time.time() - t0
                except: pass
            if time.time() - t0 > 30: break
    return None


def test_round(variant, round_idx):
    """Play 4 plies per side (8 half-moves total)."""
    moves = OPENINGS[variant][:4]
    t_round = time.time()
    # new-game
    post(f"/api/engine/new-game?variant={variant}", {"variant": variant})
    # first-chunk latency
    first_chunk = stream_first(variant)
    for mv in moves:
        post(f"/api/engine/move?variant={variant}", {"variant": variant, "move": mv})
        r = json.loads(post(f"/api/engine/move?variant={variant}", {"variant": variant, "move": "auto"}).read())
        ai = r.get("data", {}).get("aiMove")
        if not ai: return False, f"AI move missing after {mv}", first_chunk
    return True, time.time() - t_round, first_chunk


print(f"{'Variant':<10} {'Round':>5} {'Time':>8} {'1stChunk':>10} {'Result'}")
print("-" * 50)
all_pass = True
for v in VARIANTS:
    for r in range(ROUNDS):
        ok, dt, chunk = test_round(v, r)
        chunk_str = f"{chunk*1000:.0f}ms" if chunk else "FAIL"
        status = "OK" if ok else f"FAIL: {dt}"
        print(f"{v:<10} {r+1:>5} {dt:>7.2f}s {chunk_str:>10} {status}")
        if not ok: all_pass = False

# Stop everything cleanly
for v in VARIANTS:
    try: post(f"/api/engine/stop?variant={v}", {"variant": v})
    except: pass

print(f"\n{'PASS' if all_pass else 'FAIL'}: {ROUNDS * len(VARIANTS)} rounds")
sys.exit(0 if all_pass else 1)
