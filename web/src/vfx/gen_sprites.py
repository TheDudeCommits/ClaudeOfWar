#!/usr/bin/env python3
"""
Procedural sprite atlases for the ambient particle system.

Point sprites are the whole of what the viewer sees of a particle, so the alpha
profile carries all of the read. Two things matter and both are easy to get
wrong:

  * A hard-edged disc reads as lens dirt. Every sprite here is feathered with a
    non-linear falloff so the outer 20% is nearly transparent.
  * Identical sprites read as noise. Each atlas holds four distinct silhouettes
    so a crowd of 500 particles has shape variety at the near plane.

Output: 256x256 RGBA, 2x2 grid of 128px cells. Sprite content is confined to the
central ~96px of each cell so mipmap generation cannot bleed one cell into its
neighbour at the levels that matter.

    python3 gen_sprites.py
"""
import math
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "..", "public", "assets", "vfx"))

CELL = 128
PAD = 16                      # transparent gutter, mipmap safety
INNER = CELL - 2 * PAD        # 96
SS = 4                        # supersample factor for anti-aliased edges


def grid(n):
    """Centred coordinate grid in [-1, 1] of size n."""
    a = (np.arange(n) + 0.5) / n * 2.0 - 1.0
    return np.meshgrid(a, a, indexing="xy")


def radial(n, power=2.2, core=0.18):
    """Feathered disc: solid core, long soft tail. The workhorse falloff."""
    x, y = grid(n)
    r = np.sqrt(x * x + y * y)
    a = np.clip((1.0 - r) / (1.0 - core), 0.0, 1.0)
    return a ** power


def crystal(n, arms=6, arm_w=0.16, spur=0.42):
    """Dendritic six-arm flake. Reads as snow at the near plane."""
    x, y = grid(n)
    r = np.sqrt(x * x + y * y) + 1e-6
    th = np.arctan2(y, x)
    # Angular distance to the nearest arm axis.
    seg = 2.0 * math.pi / arms
    d = np.abs(((th + seg * 0.5) % seg) - seg * 0.5)
    lateral = np.sin(d) * r
    main = np.clip(1.0 - lateral / arm_w, 0.0, 1.0) * np.clip(1.0 - r, 0.0, 1.0)
    # Side spurs part-way along each arm.
    spurs = np.zeros_like(main)
    for frac in (0.34, 0.62):
        along = np.abs(r - frac)
        spurs = np.maximum(
            spurs,
            np.clip(1.0 - along / 0.07, 0.0, 1.0)
            * np.clip(1.0 - lateral / (arm_w + spur * 0.18 * (1.0 - frac)), 0.0, 1.0),
        )
    hub = np.clip(1.0 - r / 0.20, 0.0, 1.0) ** 1.4
    a = np.clip(main * 0.95 + spurs * 0.55 + hub, 0.0, 1.0)
    # Never let it go fully hard-edged; a touch of halo keeps it from aliasing.
    return np.clip(a * 0.88 + radial(n, 3.4) * 0.22, 0.0, 1.0)


def shard(n, aspect=0.34, tilt=0.35):
    """Elongated wind-blown flake / ash flake. Breaks up the disc monotony."""
    x, y = grid(n)
    c, s = math.cos(tilt), math.sin(tilt)
    u, v = x * c - y * s, x * s + y * c
    r = np.sqrt((u / 1.0) ** 2 + (v / aspect) ** 2)
    a = np.clip(1.0 - r, 0.0, 1.0) ** 1.6
    # Slight taper so one end is finer than the other.
    a *= np.clip(0.55 + 0.55 * (1.0 - (u * 0.5 + 0.5)), 0.0, 1.0)
    return np.clip(a, 0.0, 1.0)


def speck(n):
    """Tiny bright mote with a wide faint halo — the far-field particle."""
    x, y = grid(n)
    r = np.sqrt(x * x + y * y)
    core = np.clip(1.0 - r / 0.30, 0.0, 1.0) ** 1.2
    halo = np.clip(1.0 - r, 0.0, 1.0) ** 3.4
    return np.clip(core * 0.9 + halo * 0.35, 0.0, 1.0)


def streak(n, aspect=0.20):
    """Vertically stretched ember, as if motion-blurred by its own rise."""
    x, y = grid(n)
    r = np.sqrt((x / aspect) ** 2 + y * y)
    a = np.clip(1.0 - r, 0.0, 1.0) ** 1.5
    hot = np.clip(1.0 - np.sqrt(x * x + y * y) / 0.26, 0.0, 1.0) ** 1.5
    return np.clip(a * 0.75 + hot, 0.0, 1.0)


def glow(n, core=0.14, power=2.8):
    """Pure hot point for embers: small blazing core, long exponential falloff."""
    x, y = grid(n)
    r = np.sqrt(x * x + y * y)
    a = np.exp(-((r / core) ** 1.5)) * 0.85 + np.clip(1.0 - r, 0.0, 1.0) ** power
    return np.clip(a, 0.0, 1.0)


def cinder(n):
    """Irregular burning flake: a glowing rim around a dark ragged centre."""
    x, y = grid(n)
    r = np.sqrt(x * x + y * y)
    th = np.arctan2(y, x)
    wob = 1.0 + 0.16 * np.sin(th * 5.0 + 0.7) + 0.10 * np.sin(th * 3.0 - 1.9)
    edge = r / (0.70 * wob)
    body = np.clip(1.0 - edge, 0.0, 1.0) ** 0.7
    rim = np.clip(1.0 - np.abs(edge - 0.80) / 0.34, 0.0, 1.0) ** 1.6
    return np.clip(body * 0.62 + rim * 0.85, 0.0, 1.0)


def render(fn, **kw):
    """Supersample then box-down, so edges are properly anti-aliased."""
    a = fn(INNER * SS, **kw)
    img = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "L")
    return np.asarray(img.resize((INNER, INNER), Image.LANCZOS)).astype(np.float32) / 255.0


def atlas(cells, path, tint=None):
    """cells: 4 alpha arrays, row-major. tint: optional per-cell RGB triples."""
    out = np.zeros((CELL * 2, CELL * 2, 4), dtype=np.float32)
    for i, a in enumerate(cells):
        cy, cx = divmod(i, 2)
        y0, x0 = cy * CELL + PAD, cx * CELL + PAD
        rgb = (1.0, 1.0, 1.0) if tint is None else tint[i]
        for ch in range(3):
            out[y0:y0 + INNER, x0:x0 + INNER, ch] = rgb[ch]
        out[y0:y0 + INNER, x0:x0 + INNER, 3] = a
    Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGBA").save(path)
    print("wrote", path)


def main():
    os.makedirs(OUT, exist_ok=True)

    atlas(
        [
            render(crystal),
            render(radial, power=2.6),
            render(shard),
            render(speck),
        ],
        os.path.join(OUT, "flake_atlas.png"),
    )

    # Embers carry their colour ramp in the sprite (white-hot centre, orange
    # edge) so the shader only has to scale intensity.
    atlas(
        [
            render(glow),
            render(cinder),
            render(streak),
            render(speck),
        ],
        os.path.join(OUT, "ember_atlas.png"),
        tint=[
            (1.00, 0.88, 0.66),
            (1.00, 0.55, 0.22),
            (1.00, 0.74, 0.42),
            (1.00, 0.66, 0.30),
        ],
    )

    # Single soft disc used for the god-ray light source disc.
    n = 256
    a = render_full(n)
    Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "L").save(
        os.path.join(OUT, "sun_disc.png"))
    print("wrote", os.path.join(OUT, "sun_disc.png"))


def render_full(n):
    x, y = grid(n * SS)
    r = np.sqrt(x * x + y * y)
    a = np.clip(1.0 - r, 0.0, 1.0) ** 1.1
    a = np.clip(a * 0.5 + np.clip(1.0 - r / 0.55, 0.0, 1.0) ** 0.7, 0.0, 1.0)
    img = Image.fromarray((a * 255).astype(np.uint8), "L")
    return np.asarray(img.resize((n, n), Image.LANCZOS)).astype(np.float32) / 255.0


if __name__ == "__main__":
    main()
