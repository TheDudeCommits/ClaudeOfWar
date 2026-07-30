#!/usr/bin/env python3
"""Measure the objective grade signature of an image set.

Turns critic feedback from "looks flat" into "your 1st-percentile luma is 0.9%
against a reference band of 3-7%, so your blacks are crushed". Run it on the
reference pool once, then on every candidate shot.
"""
import argparse, glob, json, os, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def stats(path):
    im = Image.open(path).convert("RGB")
    im.thumbnail((640, 640))
    a = np.asarray(im).astype(np.float32) / 255.0
    lin = srgb_to_linear(a)
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    l8 = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)  # perceptual

    mx, mn = a.max(2), a.min(2)
    sat = np.where(mx > 1e-5, (mx - mn) / np.maximum(mx, 1e-5), 0.0)

    pcts = [0.1, 1, 5, 25, 50, 75, 95, 99, 99.9]
    lp = {f"p{p}": round(float(np.percentile(l8, p)), 4) for p in pcts}

    # Tone-zone hue balance: the reference grade is a teal/orange split, so
    # shadows should skew blue and highlights warm. Measured as R-B per zone.
    sh = l8 < np.percentile(l8, 25)
    hi = l8 > np.percentile(l8, 85)
    mid = (~sh) & (~hi)

    def rb(mask):
        if mask.sum() < 50: return 0.0
        return round(float((a[..., 0][mask].mean() - a[..., 2][mask].mean())), 4)

    return {
        "file": os.path.basename(path),
        "luma_pct": lp,
        "black_point": lp["p0.1"],
        "white_point": lp["p99.9"],
        "contrast_p95_p5": round(lp["p95"] - lp["p5"], 4),
        "sat_mean": round(float(sat.mean()), 4),
        "sat_p95": round(float(np.percentile(sat, 95)), 4),
        "warmth_shadows_RmB": rb(sh),
        "warmth_mids_RmB": rb(mid),
        "warmth_highs_RmB": rb(hi),
        "pure_black_frac": round(float((l8 < 0.01).mean()), 5),
        "pure_white_frac": round(float((l8 > 0.99).mean()), 5),
        # Proxy for aerial perspective / DOF: how much high-frequency energy the
        # top-centre (usually distant) band holds vs the middle band.
        "detail_far_over_mid": round(float(
            (np.abs(np.diff(l8[: l8.shape[0] // 3], axis=0)).mean() + 1e-6) /
            (np.abs(np.diff(l8[l8.shape[0] // 3: 2 * l8.shape[0] // 3], axis=0)).mean() + 1e-6)
        ), 4),
    }


def summarise(rows):
    keys = [k for k in rows[0] if k not in ("file", "luma_pct")]
    out = {}
    for k in keys:
        v = sorted(r[k] for r in rows)
        out[k] = {"min": round(v[0], 4), "median": round(v[len(v) // 2], 4),
                  "max": round(v[-1], 4)}
    lk = rows[0]["luma_pct"].keys()
    out["luma_pct"] = {}
    for p in lk:
        v = sorted(r["luma_pct"][p] for r in rows)
        out["luma_pct"][p] = {"min": round(v[0], 4), "median": round(v[len(v) // 2], 4),
                              "max": round(v[-1], 4)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--summary", action="store_true")
    a = ap.parse_args()
    files = []
    for p in a.paths:
        files += sorted(glob.glob(os.path.join(p, "*"))) if os.path.isdir(p) else [p]
    files = [f for f in files if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
    rows = [stats(f) for f in files]
    print(json.dumps(summarise(rows) if a.summary else rows, indent=2))


if __name__ == "__main__":
    main()
