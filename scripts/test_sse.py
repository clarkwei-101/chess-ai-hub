#!/usr/bin/env python3
"""Real test: measure time to first analysis chunk for all 3 variants."""
import json
import sys
import time
import urllib.request
import urllib.parse

BASE = "http://localhost:3002"
VARIANTS = ["chess", "xiangqi", "go"]


def first_chunk_time(variant: str, depth: int = 18, multipv: int = 3) -> dict:
    """Open SSE stream, measure time to first analysis chunk."""
    url = f"{BASE}/api/engine/analyze?variant={variant}&depth={depth}&multipv={multipv}"
    req = urllib.request.Request(url)
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=30) as resp:
        chunks = []
        header_time = None
        first_analysis_time = None
        last_analysis_time = None
        max_depth = 0
        max_score_cp = None
        for raw_line in resp:
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if header_time is None and line == "":
                # SSE headers ended (first blank line)
                header_time = time.time() - t0
            if line.startswith("data:"):
                try:
                    payload = json.loads(line[5:].strip())
                except Exception:
                    continue
                if payload.get("ok") and payload.get("analysis"):
                    if first_analysis_time is None:
                        first_analysis_time = time.time() - t0
                    last_analysis_time = time.time() - t0
                    a = payload["analysis"]
                    if a.get("depth") and a["depth"] > max_depth:
                        max_depth = a["depth"]
                    lines = a.get("lines", [])
                    if lines and lines[0].get("scoreCp") is not None:
                        max_score_cp = lines[0]["scoreCp"]
                    chunks.append(a)
                else:
                    print(f"  [{variant}] error: {payload.get('error')}")
                    break
            if first_analysis_time and time.time() - t0 > first_analysis_time + 4:
                # collected enough after first chunk
                break
        return {
            "variant": variant,
            "header_ms": round((header_time or 0) * 1000, 1),
            "first_chunk_ms": round((first_analysis_time or 0) * 1000, 1),
            "chunks": len(chunks),
            "max_depth": max_depth,
            "best_score_cp": max_score_cp,
            "ok": first_analysis_time is not None,
        }


print(f"{'Variant':<10} {'Header':>9} {'First':>9} {'#Chunks':>9} {'MaxDepth':>10} {'BestCP':>8}")
print("-" * 60)
results = []
for v in VARIANTS:
    try:
        r = first_chunk_time(v)
    except Exception as e:
        r = {"variant": v, "ok": False, "error": str(e)}
    results.append(r)
    if r.get("ok"):
        print(f"{r['variant']:<10} {r['header_ms']:>8.1f}ms {r['first_chunk_ms']:>8.1f}ms {r['chunks']:>9} {r['max_depth']:>10} {str(r['best_score_cp']):>8}")
    else:
        print(f"{r['variant']:<10} {'FAIL':>9}  {r.get('error', '')}")

ok = sum(1 for r in results if r.get("ok"))
print()
print(f"PASSED: {ok}/{len(results)}")
sys.exit(0 if ok == len(results) else 1)
