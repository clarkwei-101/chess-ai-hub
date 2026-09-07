#!/usr/bin/env python3
"""Full end-to-end test:
1. Start engine (per variant)
2. Apply a known opening move
3. AI moves
4. Apply another move + AI moves
5. Stop cleanly

Verifies the entire /api/engine/* surface for all 3 variants.
"""
import json
import sys
import time
import urllib.request

BASE = "http://localhost:3002"

POST = lambda path, body=None: urllib.request.urlopen(
    urllib.request.Request(f"{BASE}{path}", data=json.dumps(body or {}).encode(),
    headers={"Content-Type": "application/json"}, method="POST"),
    timeout=30,
)

OPENINGS = {
    "chess": ["e2e4", "e7e5", "g1f3"],
    "xiangqi": ["h2e2", "h9e7", "h0g2"],
    "go": ["D4", "Q16", "D16"],
}


def test_variant(variant: str):
    name = variant
    print(f"\n=== {name.upper()} ===")

    # 1. Start
    t0 = time.time()
    r = json.loads(POST(f"/api/engine/start?variant={variant}", {"variant": variant}).read())
    print(f"  start: {time.time()-t0:.2f}s — ok={r.get('ok')}")
    if not r.get("ok"): return False

    # 2. new-game
    t0 = time.time()
    r = json.loads(POST(f"/api/engine/new-game?variant={variant}", {"variant": variant}).read())
    print(f"  new-game: {time.time()-t0:.2f}s — ok={r.get('ok')}")
    if not r.get("ok"): return False

    # 3. Apply opening moves + AI responses
    for i, mv in enumerate(OPENINGS[variant][:2]):
        # Player move
        t0 = time.time()
        r = json.loads(POST(f"/api/engine/move?variant={variant}", {"variant": variant, "move": mv}).read())
        apply_dt = time.time() - t0
        print(f"  apply {mv}: {apply_dt:.2f}s — ok={r.get('ok')} legal={r.get('data', {}).get('legal')}")
        if not r.get("ok"): return False

        # AI move (auto)
        t0 = time.time()
        try:
            r = json.loads(POST(f"/api/engine/move?variant={variant}", {"variant": variant, "move": "auto"}).read())
            ai_dt = time.time() - t0
            data = r.get("data", {})
            ai = data.get("aiMove") or data.get("move")
            print(f"  AI move: {ai_dt:.2f}s — {ai}  legal={data.get('legal')}")
            if not r.get("ok") or not ai: return False
        except Exception as e:
            print(f"  AI move failed: {e}")
            return False

    # 4. Stop
    r = json.loads(POST(f"/api/engine/stop?variant={variant}", {"variant": variant}).read())
    print(f"  stop: ok={r.get('ok')}")
    return True


ok = 0
for v in ["chess", "xiangqi", "go"]:
    try:
        if test_variant(v): ok += 1
    except Exception as e:
        print(f"  EXCEPTION: {e}")

print(f"\nPASSED: {ok}/3")
sys.exit(0 if ok == 3 else 1)
