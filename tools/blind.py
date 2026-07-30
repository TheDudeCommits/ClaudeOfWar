#!/usr/bin/env python3
"""Build a blind A/B plate: our capture and a reference plate, side by side,
randomly ordered, letterboxed to identical size, with no labels.

The answer key is written to a SEPARATE file the critic must not open until it
has recorded a verdict. This is the whole point — a critic that knows which is
which grades the label, not the image.
"""
import argparse, hashlib, json, os, random, time
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def norm(path, size=(1280, 720)):
    im = Image.open(path).convert("RGB")
    # Reference plates are 16:9 but arrive at many resolutions. Fit both sides
    # to identical pixels so resolution itself is not a tell.
    return ImageOps.fit(im, size, method=Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ours", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", default=None)
    a = ap.parse_args()

    seed = a.seed or f"{a.ours}:{time.time()}"
    rng = random.Random(hashlib.sha256(seed.encode()).hexdigest())
    ours_left = rng.random() < 0.5

    L, R = (a.ours, a.ref) if ours_left else (a.ref, a.ours)
    li, ri = norm(L), norm(R)

    gap = 16
    canvas = Image.new("RGB", (li.width + ri.width + gap, li.height), (18, 18, 20))
    canvas.paste(li, (0, 0))
    canvas.paste(ri, (li.width + gap, 0))
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    canvas.save(a.out, quality=95)

    key_path = a.out.replace(".png", "") + ".KEY.json"
    json.dump({
        "left": "OURS" if ours_left else "REFERENCE",
        "right": "REFERENCE" if ours_left else "OURS",
        "ours": a.ours, "ref": a.ref,
    }, open(key_path, "w"), indent=2)

    print(f"blind plate -> {a.out}")
    print(f"answer key  -> {key_path}   (DO NOT OPEN BEFORE RECORDING A VERDICT)")


if __name__ == "__main__":
    main()
