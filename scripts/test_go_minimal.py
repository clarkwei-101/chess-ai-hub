#!/usr/bin/env python3
"""Minimal SSE test matching test_go_detailed.py exactly."""
import urllib.request, json, time

BASE = "http://localhost:3002"
url = f"{BASE}/api/engine/analyze?variant=go&depth=18&multipv=3"

def post(path, body=None, timeout=30):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())

# Start
post("/api/engine/start?variant=go", {"variant": "go"})
post("/api/engine/new-game?variant=go", {"variant": "go"})

# SSE R1 - 3 chunks then break
print("=== SSE R1 ===")
t0 = time.time()
chunks = 0
with urllib.request.urlopen(url, timeout=20) as resp:
    for raw_line in resp:
        line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
        if line.startswith("data:"):
            try:
                payload = json.loads(line[5:].strip())
                if payload.get("ok") and payload.get("analysis"):
                    chunks += 1
                    if chunks == 1:
                        print(f"  R1 chunk#1: {time.time()-t0:.3f}s lines={len(payload['analysis'].get('lines',[]))}")
            except: pass
        if chunks >= 3: break
print(f"  R1: {chunks} chunks in {time.time()-t0:.3f}s")

# Apply moves + AI (exactly like test_go_detailed.py)
for mv in ["D4", "Q16", "R6", "D17", "R4", "Q4"]:
    t0 = time.time()
    r = post("/api/engine/move?variant=go", {"variant": "go", "move": mv}, timeout=15)
    print(f"  apply {mv}: {time.time()-t0:.3f}s legal={r.get('data',{}).get('legal')}", flush=True)
    t0 = time.time()
    r = post("/api/engine/move?variant=go", {"variant": "go", "move": "auto"}, timeout=20)
    ai = r.get("data", {}).get("aiMove")
    print(f"  AI: {time.time()-t0:.3f}s -> {ai}", flush=True)

# new-game
print("new-game...", flush=True)
t0 = time.time()
r = post("/api/engine/new-game?variant=go", {"variant": "go"})
print(f"new-game: {time.time()-t0:.3f}s ok={r.get('ok')}", flush=True)

# SSE R2
print("=== SSE R2 ===")
t0 = time.time()
chunks = 0
try:
    with urllib.request.urlopen(url, timeout=20) as resp:
        for raw_line in resp:
            line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith("data:"):
                try:
                    payload = json.loads(line[5:].strip())
                    if payload.get("ok") and payload.get("analysis"):
                        chunks += 1
                        if chunks == 1:
                            print(f"  R2 chunk#1: {time.time()-t0:.3f}s lines={len(payload['analysis'].get('lines',[]))}")
                except: pass
            if chunks >= 3: break
    print(f"  R2: {chunks} chunks in {time.time()-t0:.3f}s")
except Exception as e:
    print(f"  R2 ERROR: {e}")
