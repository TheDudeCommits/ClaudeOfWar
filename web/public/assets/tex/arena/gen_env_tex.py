#!/usr/bin/env python3
"""Re-author the environment maps that shipped as flat colour swatches.

`snow_albedo` had a luma std of 0.0053 — literally a white square. `rope_albedo`
and `dirt_albedo` were barely better (macro range 0.024 / 0.063). A flat albedo
guarantees the "single-colour large surface" fail tell (ART_BIBLE §12.9), and no
amount of lighting rescues it.

Everything here is spectral-synthesis noise: a power-law amplitude spectrum with
random phase, inverse-FFT'd. That is periodic by construction, so the maps tile
seamlessly, and the spectral slope gives direct control over how much energy
lands at macro vs micro scale — which is the exact axis the critic measured.

    python3 gen_env_tex.py            # all maps
    python3 gen_env_tex.py snow macro # a subset

Writes albedo/normal/orm triplets next to itself.
"""
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 2048


# ----------------------------------------------------------------- noise core

def fbm(size, rng, beta=1.9, lo=2.0, hi=None):
    """Periodic fractal noise, |F(k)| ~ k^-beta. Returns 0..1."""
    f = np.fft.fftfreq(size) * size
    fx, fy = np.meshgrid(f, f)
    r = np.sqrt(fx * fx + fy * fy)
    r[0, 0] = 1.0
    amp = r ** (-beta)
    amp[r < lo] = 0.0
    if hi:
        amp[r > hi] = 0.0
    amp[0, 0] = 0.0
    spec = amp * np.exp(1j * rng.random((size, size)) * 2.0 * np.pi)
    img = np.real(np.fft.ifft2(spec)).astype(np.float32)
    img -= img.min()
    return img / (img.max() + 1e-9)


def anisotropic(size, rng, beta=1.9, lo=2.0, stretch=6.0, angle=0.35):
    """Wind-blown noise: the spectrum is squashed along one axis, so features
    elongate perpendicular to it. Snow scallops and wood grain both need this."""
    f = np.fft.fftfreq(size) * size
    fx, fy = np.meshgrid(f, f)
    ca, sa = np.cos(angle), np.sin(angle)
    u = fx * ca + fy * sa
    v = (-fx * sa + fy * ca) * stretch
    r = np.sqrt(u * u + v * v)
    r[0, 0] = 1.0
    amp = r ** (-beta)
    amp[np.sqrt(fx * fx + fy * fy) < lo] = 0.0
    amp[0, 0] = 0.0
    spec = amp * np.exp(1j * rng.random((size, size)) * 2.0 * np.pi)
    img = np.real(np.fft.ifft2(spec)).astype(np.float32)
    img -= img.min()
    return img / (img.max() + 1e-9)


def equalize(a):
    """Rank transform to a flat 0..1 histogram. Without it, summed octaves pile
    up in a narrow gaussian around 0.5 and every derived map reads as flat."""
    flat = a.ravel()
    order = np.argsort(flat, kind="stable")
    rank = np.empty(order.shape, np.int64)
    rank[order] = np.arange(order.size)
    return (rank / (order.size - 1)).astype(np.float32).reshape(a.shape)


def warp(a, dx, dy, amount):
    """Domain warp by a displacement field, wrapping at the edges."""
    n = a.shape[0]
    yy, xx = np.mgrid[0:n, 0:n]
    sx = np.mod(xx + (dx - 0.5) * amount, n).astype(np.int32)
    sy = np.mod(yy + (dy - 0.5) * amount, n).astype(np.int32)
    return a[sy, sx]


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0 + 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def blur(a, px):
    """Cheap periodic gaussian via the FFT we already depend on."""
    n = a.shape[0]
    f = np.fft.fftfreq(n) * n
    fx, fy = np.meshgrid(f, f)
    k = np.exp(-2.0 * (np.pi * px / n) ** 2 * (fx * fx + fy * fy))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * k)).astype(np.float32)


def sobel_normal(h, strength=1.0):
    """Tangent-space normal from a height field, wrapped so it stays tileable."""
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    gx += (np.roll(h, -2, 1) - np.roll(h, 2, 1)) * 0.25
    gy += (np.roll(h, -2, 0) - np.roll(h, 2, 0)) * 0.25
    s = strength * h.shape[0] / 512.0
    n = np.stack([-gx * s, gy * s, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return (n * 0.5 + 0.5).astype(np.float32)


def cavity_ao(h, radius=14.0, strength=1.0):
    """Concavity proxy: how far below the local mean a texel sits."""
    d = blur(h, radius) - h
    ao = 1.0 - np.clip(d * 3.2 * strength, 0.0, 1.0)
    return np.clip(ao * 0.35 + 0.65, 0.0, 1.0)


def specks(size, rng, count, radius):
    """Sparse bright points — snow sparkle, mica in stone."""
    out = np.zeros((size, size), np.float32)
    ys = rng.integers(0, size, count)
    xs = rng.integers(0, size, count)
    out[ys, xs] = 1.0
    return np.clip(blur(out, radius) * (radius * radius * 5.0), 0.0, 1.0)


def save(name, arr, srgb_hint=""):
    a = np.clip(arr, 0.0, 1.0)
    if a.ndim == 2:
        a = np.stack([a] * 3, -1)
    Image.fromarray((a * 255.0 + 0.5).astype(np.uint8)).save(
        os.path.join(HERE, name + ".png"))
    g = a[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    n = 8
    bh = g.shape[0] // n
    blocks = g[:bh * n, :bh * n].reshape(n, bh, n, bh).mean(axis=(1, 3))
    print(f"  {name+'.png':26s} mean {g.mean():.3f} std {g.std():.4f} "
          f"macro8 std {blocks.std():.4f} range {blocks.max()-blocks.min():.4f}"
          f" {srgb_hint}")


def orm(ao, rough, metal=None):
    m = np.zeros_like(ao) if metal is None else metal
    return np.stack([ao, np.clip(rough, 0.0, 1.0), m], -1)


# --------------------------------------------------------------------- snow

def gen_snow(size=SIZE):
    """Wind-packed snow: scalloped drifts, a crust that breaks into hard edges,
    and mica-fine sparkle. ART_BIBLE §7 wants albedo high but NOT clipped — the
    old map sat at 0.94 flat, which is why sunlit snow blew out."""
    print("snow")
    rng = np.random.default_rng(2027)

    drift = anisotropic(size, rng, beta=2.35, lo=2, stretch=5.0, angle=0.55)
    scallop = anisotropic(size, rng, beta=1.55, lo=8, stretch=3.4, angle=0.42)
    grain = fbm(size, rng, beta=1.25, lo=90)
    fine = fbm(size, rng, beta=0.95, lo=260)

    h = equalize(0.60 * drift + 0.30 * scallop + 0.10 * grain)
    # Domain-warp the drifts so the scallops curl instead of running straight.
    wx, wy = fbm(size, rng, beta=2.2, lo=2), fbm(size, rng, beta=2.2, lo=2)
    h = equalize(warp(h, wx, wy, size * 0.035))
    h = 0.86 * h + 0.14 * fine

    # Crust: wind-glazed snow cracks along the steep faces of a drift. Slope
    # magnitude finds them without needing an explicit crack layer.
    gx = np.roll(h, -1, 1) - np.roll(h, 1, 1)
    gy = np.roll(h, -1, 0) - np.roll(h, 1, 0)
    slope = np.sqrt(gx * gx + gy * gy)
    slope = equalize(blur(slope, 1.5))
    crust = smoothstep(0.80, 0.97, slope)

    sparkle = specks(size, rng, size * size // 2600, 1.15)

    # 0.72..0.90 sRGB. Shadowed hollows carry the sky's blue, crests stay neutral.
    v = 0.735 + 0.150 * h + 0.055 * crust - 0.030 * (1.0 - h) ** 2
    v = np.clip(v + 0.045 * sparkle, 0.0, 0.925)
    blue = 0.016 * (1.0 - h)
    alb = np.stack([v - blue * 0.55, v - blue * 0.12, v + blue], -1)
    save("snow_albedo", alb)

    nrm = sobel_normal(h * 0.55 + fine * 0.30 + grain * 0.15, strength=2.1)
    nrm[..., 0] = np.clip(nrm[..., 0] + (sparkle - 0.5) * sparkle * 0.30, 0, 1)
    save("snow_normal", nrm)

    # Fresh powder is matte; the wind crust is glazed and near-icy.
    rough = 0.80 - 0.16 * h - 0.34 * crust - 0.42 * sparkle
    rough = np.clip(rough + (grain - 0.5) * 0.10, 0.18, 0.92)
    save("snow_orm", orm(cavity_ao(h, 22.0), rough))


# --------------------------------------------------------------------- dirt

def gen_dirt(size=SIZE):
    """Trodden earth: pebbles pressed into damp soil, drag scuffs, dry cracks."""
    print("dirt")
    rng = np.random.default_rng(4051)

    base = fbm(size, rng, beta=2.2, lo=2)
    clods = equalize(fbm(size, rng, beta=1.45, lo=26))
    grit = fbm(size, rng, beta=1.05, lo=140)
    micro = fbm(size, rng, beta=0.85, lo=380)

    # Pebbles: threshold a mid-frequency field, then dome the surviving blobs.
    pf = equalize(fbm(size, rng, beta=1.30, lo=46))
    peb = smoothstep(0.855, 0.94, pf)
    peb = np.clip(blur(peb, 1.2) * 1.15, 0.0, 1.0)

    # Cracks: the thin contour band of a warped field reads as a shrinkage net.
    cf = equalize(fbm(size, rng, beta=2.0, lo=9))
    cw = 1.0 - smoothstep(0.0, 0.035, np.abs(cf - 0.5))
    cracks = np.clip(blur(cw, 1.0), 0.0, 1.0)

    scuff = anisotropic(size, rng, beta=1.6, lo=14, stretch=7.0, angle=1.15)

    h = np.clip(0.44 * base + 0.24 * clods + 0.16 * grit + 0.10 * micro
                + 0.34 * peb - 0.30 * cracks + 0.06 * scuff, 0.0, 1.0)
    h = equalize(h)

    wet = smoothstep(0.42, 0.06, h)          # water sits in the low spots
    # Cold northern loam: desaturated brown, pebbles grey and lighter.
    dry = np.stack([0.415, 0.352, 0.288], -1).astype(np.float32)
    dmp = np.stack([0.150, 0.128, 0.112], -1).astype(np.float32)
    tone = (0.55 + 0.75 * h)[..., None]
    alb = dry[None, None] * tone
    alb = alb * (1.0 - wet[..., None]) + dmp[None, None] * (1.0 + 0.5 * h[..., None]) * wet[..., None]
    stone = np.stack([0.475, 0.470, 0.462], -1).astype(np.float32)
    pw = (peb * 0.85)[..., None]
    alb = alb * (1.0 - pw) + stone[None, None] * (0.72 + 0.55 * clods[..., None]) * pw
    alb *= (0.86 + 0.28 * grit)[..., None]
    alb *= (1.0 - 0.30 * cracks)[..., None]
    save("dirt_albedo", np.clip(alb, 0.03, 0.72))

    save("dirt_normal", sobel_normal(
        0.55 * h + 0.28 * peb + 0.22 * grit + 0.16 * micro - 0.24 * cracks, 2.5))

    rough = 0.94 - 0.10 * clods - 0.20 * peb - 0.44 * wet
    rough = np.clip(rough + (micro - 0.5) * 0.12, 0.16, 0.98)
    save("dirt_orm", orm(cavity_ao(h, 16.0), rough))


# --------------------------------------------------------------------- rope

def gen_rope(size=SIZE):
    """Three-strand laid hemp. The helix has to be explicit — noise alone never
    reads as rope, it reads as fur."""
    print("rope")
    rng = np.random.default_rng(9137)

    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size
    strands, twists = 3.0, 26.0
    # Phase of the laid strand along the rope axis (u), with the helix skew.
    ph = (x * strands + y * twists) % 1.0
    lay = np.cos((ph - 0.5) * 2.0 * np.pi) * 0.5 + 0.5          # round strand
    lay = lay ** 0.72
    # Individual fibres run along the strand, sheared by the same helix.
    fib = anisotropic(size, rng, beta=1.35, lo=40, stretch=9.0, angle=-1.28)
    fuzz = fbm(size, rng, beta=1.0, lo=220)
    wearf = equalize(fbm(size, rng, beta=2.0, lo=5))
    frayed = smoothstep(0.72, 0.97, wearf)

    h = np.clip(0.62 * lay + 0.26 * fib + 0.12 * fuzz, 0.0, 1.0)
    h = np.clip(h - 0.18 * frayed * fuzz, 0.0, 1.0)

    hemp = np.stack([0.415, 0.336, 0.212], -1).astype(np.float32)
    grey = np.stack([0.300, 0.286, 0.262], -1).astype(np.float32)
    tone = (0.42 + 0.92 * h)[..., None]
    alb = hemp[None, None] * tone
    # Weathered/greyed patches where the rope has been rained on.
    alb = alb * (1.0 - frayed[..., None] * 0.65) + \
        grey[None, None] * tone * frayed[..., None] * 0.65
    alb *= (0.80 + 0.40 * fib)[..., None]
    # Deep shadow in the valleys between laid strands.
    alb *= (0.34 + 0.66 * smoothstep(0.0, 0.42, lay))[..., None]
    save("rope_albedo", np.clip(alb, 0.02, 0.62))

    save("rope_normal", sobel_normal(0.60 * h + 0.40 * fib, 3.0))

    rough = np.clip(0.88 - 0.10 * fib + 0.08 * frayed + (fuzz - 0.5) * 0.14,
                    0.55, 0.99)
    save("rope_orm", orm(cavity_ao(h, 10.0) * (0.55 + 0.45 * lay), rough))


# ------------------------------------------------------------ macro variation

def gen_macro(size=1024):
    """The breakup mask. Sampled in WORLD space at ~6-12 m per repeat, so its
    only job is to carry energy across every scale from ~1 cm to ~10 m and to
    have a flat histogram — a gaussian-humped mask spends 80% of its area doing
    nothing, which is why the shipped 512 version could not drive a wet zone
    (only 0.37% of it fell below 0.3)."""
    print("macro_variation")
    rng = np.random.default_rng(1811)

    base = fbm(size, rng, beta=1.75, lo=1)
    mid = fbm(size, rng, beta=1.30, lo=12)
    fine = fbm(size, rng, beta=1.00, lo=64)

    m = equalize(0.55 * base + 0.30 * mid + 0.15 * fine)
    wx, wy = fbm(size, rng, beta=2.1, lo=1), fbm(size, rng, beta=2.1, lo=1)
    m = equalize(warp(m, wx, wy, size * 0.06))

    # Drainage corridors: the zero-contour band of an independent field carves
    # connected low channels, which is where water actually pools. A plain blob
    # mask gives round puddles and reads as leopard print.
    ch = equalize(fbm(size, rng, beta=2.1, lo=3))
    chan = 1.0 - smoothstep(0.0, 0.085, np.abs(ch - 0.5))
    m = np.clip(m - 0.55 * chan, 0.0, 1.0)
    m = equalize(m * 0.88 + 0.12 * fine)

    save("macro_variation", m)


GENS = {"snow": gen_snow, "dirt": gen_dirt, "rope": gen_rope,
        "macro": gen_macro}

if __name__ == "__main__":
    want = sys.argv[1:] or list(GENS)
    for k in want:
        GENS[k]()
