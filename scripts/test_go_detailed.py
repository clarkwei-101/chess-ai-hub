#!/usr/bin/env python3
"""Detailed Go KataGo SSE test — see exactly when it hangs."""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = "http://localhost:3002"

def post(path, body=None):
    try:
        return urllib.request.urlopen(
            urllib.request.Request(f"{BASE}{path}",
                data=json.dumps(body or {}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST"),
            timeout=60,
        )
    except urllib.error.HTTPError as e:
        return e

def timed(label, fn):
    t0 = time.time()
    try:
        r = fn()
        dt = time.time() - t0
        print(f"  {label}: {dt:.2f}s ok={r.get('ok')}")
        return r
    except Exception as e:
        dt = time.time() - t0
        print(f"  {label}: {dt:.2f}s FAIL {e}")
        return None

# Start fresh Go session
print("\n=== GO variant test ===\n")
timed("start", lambda: json.loads(post("/api/engine/start?variant=go", {"variant": "go"}).read()))
timed("new-game", lambda: json.loads(post("/api/engine/new-game?variant=go", {"variant": "go"}).read()))

# Open SSE — time first chunk
print("\n=== First SSE chunk timing ===")
url = f"{BASE}/api/engine/analyze?variant=go&depth=18&multipv=3"
t0 = time.time()
chunk_count = 0
try:
    with urllib.request.urlopen(url, timeout=45) as r:
        for raw in r:
            line = raw.decode().rstrip()
            elapsed = time.time() - t0
            if line.startswith("data:"):
                try:
                    p = json.loads(line[5:].strip())
                    if p.get("ok") and p.get("analysis"):
                        chunk_count += 1
                        if chunk_count <= 3:
                            a = p["analysis"]
                            print(f"  chunk#{chunk_count} t={elapsed:.2f}s lines={len(a.get('lines',[]))} depth={a.get('depth')}")
                except: pass
            if chunk_count >= 3: break
            if elapsed > 40:
                print(f"  TIMEOUT after {elapsed:.2f}s, only {chunk_count} chunks")
                break
except Exception as e:
    print(f"  SSE error: {e}")

# Now do a real move
print("\n=== Apply moves + AI ===")
for i, mv in enumerate(["D4", "Q16", "R6", "D17", "R4", "Q4"]):
    t0 = time.time()
    r = json.loads(post("/api/engine/move?variant=go", {"variant": "go", "move": mv}).read())
    print(f"  apply {mv}: {time.time()-t0:.2f}s legal={r.get('data',{}).get('legal')}")
    t0 = time.time()
    r = json.loads(post("/api/engine/move?variant=go", {"variant": "go", "move": "auto"}).read())
    print(f"  AI: {time.time()-t0:.2f}s move={r.get('data',{}).get('aiMove')}")

# Now new game and try second SSE round
print("\n=== Second SSE after new-game ===")
timed("new-game", lambda: json.loads(post("/api/engine/new-game?variant=go", {"variant": "go"}).read()))
t0 = time.time()
chunk_count = 0
try:
    with urllib.request.urlopen(url, timeout=45) as r:
        for raw in r:
            line = raw.decode().rstrip()
            elapsed = time.time() - t0
            if line.startswith("data:"):
                try:
                    p = json.loads(line[5:].strip())
                    if p.get("ok") and p.get("analysis"):
                        chunk_count += 1
                        if chunk_count <= 3:
                            a = p["analysis"]
                            print(f"  chunk#{chunk_count} t={elapsed:.2f}s lines={len(a.get('lines',[]))}")
                except: pass
            if chunk_count >= 3: break
            if elapsed > 40:
                print(f"  ROUND 2 TIMEOUT after {elapsed:.2f}s, only {chunk_count} chunks")
                break
except Exception as e:
    print(f"  Round 2 SSE error: {e}")

# Stop cleanly
timed("stop", lambda: json.loads(post("/api/engine/stop?variant=go", {"variant": "go"}).read()))
