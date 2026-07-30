#!/usr/bin/env python3
"""Batch shot capture. Serializes Godot runs (one Metal window at a time)."""
import argparse, fcntl, json, os, subprocess, sys, time
from contextlib import contextmanager

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK = os.path.join(ROOT, ".godot.lock")


@contextmanager
def godot_lock():
    """Only one Godot process at a time: parallel agents would otherwise race the
    .godot import cache and fight over the Metal window."""
    f = open(LOCK, "w")
    fcntl.flock(f, fcntl.LOCK_EX)
    try:
        yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()
GODOT = os.path.join(ROOT, "tools", "Godot.app", "Contents", "MacOS", "Godot")
GAME = os.path.join(ROOT, "game")
SHOTS = os.path.join(ROOT, "shots")


def capture(shot, out_path, timeout=180):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if os.path.exists(out_path):
        os.remove(out_path)
    cmd = [GODOT, "--path", GAME, "--", f"--shot={shot}", f"--out={out_path}"]
    t0 = time.time()
    with godot_lock():
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            out = (p.stdout or "") + (p.stderr or "")
        except subprocess.TimeoutExpired as e:
            out = f"TIMEOUT after {timeout}s\n" + (e.stdout or b"").decode("utf8", "replace")
    ok = os.path.exists(out_path) and os.path.getsize(out_path) > 1000
    dt = time.time() - t0
    status = "OK " if ok else "FAIL"
    print(f"[{status}] {shot:24s} {dt:5.1f}s -> {out_path}")
    if not ok:
        tail = "\n".join(out.strip().splitlines()[-25:])
        print("  ---- godot output ----")
        print("  " + tail.replace("\n", "\n  "))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--round", required=True)
    ap.add_argument("--shots", required=True, help="comma separated shot spec names")
    ap.add_argument("--timeout", type=int, default=180)
    a = ap.parse_args()

    outdir = os.path.join(SHOTS, f"round{a.round}")
    names = [s.strip() for s in a.shots.split(",") if s.strip()]
    results = {}
    for n in names:
        results[n] = capture(n, os.path.join(outdir, n + ".png"), a.timeout)

    manifest = os.path.join(outdir, "manifest.json")
    json.dump({"round": a.round, "shots": results, "ts": time.time()},
              open(manifest, "w"), indent=2)
    nok = sum(1 for v in results.values() if v)
    print(f"\n{nok}/{len(results)} captured -> {outdir}")
    sys.exit(0 if nok == len(results) else 1)


if __name__ == "__main__":
    main()
