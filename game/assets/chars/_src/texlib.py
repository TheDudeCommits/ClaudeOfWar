"""Procedural texture primitives for ClaudeOfWar characters.

Pure numpy + PIL. Everything here exists to satisfy ART_BIBLE §7/§12: no
material in this project is allowed a constant roughness, so every map we ship
gets real multi-octave variation and a pore/weave-scale normal on top.

Coordinate convention: arrays are (H, W) float32 in 0..1 unless noted.
"""
from __future__ import annotations

import numpy as np
from PIL import Image


# --------------------------------------------------------------------- noise

def _hash_grid(w: int, h: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.random((h, w)).astype(np.float32)


def _smooth(t: np.ndarray) -> np.ndarray:
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


def value_noise(shape, freq: int, seed: int, tileable: bool = True) -> np.ndarray:
    """Bilinear value noise on a `freq x freq` lattice, wrapping at the edges."""
    h, w = shape
    g = _hash_grid(freq, freq, seed)
    if tileable:
        g = np.pad(g, ((0, 1), (0, 1)), mode="wrap")
    else:
        g = np.pad(g, ((0, 1), (0, 1)), mode="edge")

    ys = np.linspace(0.0, freq, h, endpoint=False, dtype=np.float32)
    xs = np.linspace(0.0, freq, w, endpoint=False, dtype=np.float32)
    y0 = np.floor(ys).astype(np.int32)
    x0 = np.floor(xs).astype(np.int32)
    fy = _smooth(ys - y0)[:, None]
    fx = _smooth(xs - x0)[None, :]

    a = g[np.ix_(y0, x0)]
    b = g[np.ix_(y0, x0 + 1)]
    c = g[np.ix_(y0 + 1, x0)]
    d = g[np.ix_(y0 + 1, x0 + 1)]
    top = a + (b - a) * fx
    bot = c + (d - c) * fx
    return (top + (bot - top) * fy).astype(np.float32)


def fbm(shape, base_freq: int, octaves: int, seed: int,
        gain: float = 0.5, lacunarity: int = 2) -> np.ndarray:
    out = np.zeros(shape, np.float32)
    amp = 1.0
    total = 0.0
    freq = base_freq
    for o in range(octaves):
        out += value_noise(shape, max(2, freq), seed + o * 977) * amp
        total += amp
        amp *= gain
        freq *= lacunarity
    return out / max(total, 1e-6)


def ridged(shape, base_freq: int, octaves: int, seed: int) -> np.ndarray:
    """Sharp creased noise — leather cracks, dried skin, bark."""
    n = fbm(shape, base_freq, octaves, seed)
    return np.abs(n * 2.0 - 1.0)


def voronoi(shape, cells: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Returns (F1 distance 0..1, cell id noise 0..1). Tileable via wrapped points."""
    h, w = shape
    rng = np.random.default_rng(seed)
    pts = rng.random((cells, 2)).astype(np.float32)
    ids = rng.random(cells).astype(np.float32)

    ys = np.linspace(0.0, 1.0, h, endpoint=False, dtype=np.float32)[:, None]
    xs = np.linspace(0.0, 1.0, w, endpoint=False, dtype=np.float32)[None, :]

    best = np.full(shape, 4.0, np.float32)
    best_id = np.zeros(shape, np.float32)
    for i in range(cells):
        dy = np.abs(ys - pts[i, 0])
        dy = np.minimum(dy, 1.0 - dy)
        dx = np.abs(xs - pts[i, 1])
        dx = np.minimum(dx, 1.0 - dx)
        d = dy * dy + dx * dx
        m = d < best
        best = np.where(m, d, best)
        best_id = np.where(m, ids[i], best_id)
    best = np.sqrt(best)
    best /= max(best.max(), 1e-6)
    return best.astype(np.float32), best_id


def scratches(shape, count: int, seed: int, length: float = 0.35,
              width: int = 1) -> np.ndarray:
    """Thin anisotropic streaks — tool marks on steel, wear on leather."""
    h, w = shape
    rng = np.random.default_rng(seed)
    img = np.zeros(shape, np.float32)
    for _ in range(count):
        y0 = rng.integers(0, h)
        x0 = rng.integers(0, w)
        ang = rng.normal(0.0, 0.5)
        ln = int(abs(rng.normal(0.0, length)) * w) + 4
        strength = float(rng.random()) * 0.8 + 0.2
        t = np.arange(ln)
        ys = (y0 + np.sin(ang) * t).astype(np.int32) % h
        xs = (x0 + np.cos(ang) * t).astype(np.int32) % w
        for dy in range(-width, width + 1):
            img[(ys + dy) % h, xs] = np.maximum(img[(ys + dy) % h, xs], strength)
    return img


# --------------------------------------------------------------- conversions

def height_gradient(height: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Central-difference gradient, rescaled so its 99th percentile magnitude is
    1.0. Normalising here is what makes `strength` mean something physical
    downstream — it becomes the tangent of the steepest slope — instead of
    depending on whatever amplitude the height field happened to have."""
    hx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    hy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5
    m = float(np.percentile(np.hypot(hx, hy), 99.0))
    if m > 1e-8:
        hx = hx / m
        hy = hy / m
    return hx.astype(np.float32), hy.astype(np.float32)


def normal_from_gradient(hx: np.ndarray, hy: np.ndarray, slope) -> np.ndarray:
    """Tangent-space normal, OpenGL (+Y up). `slope` is tan(max tilt) and may be
    a per-texel array, which is how one atlas carries gentle pore relief on skin
    and hard cracked relief on leather at the same time."""
    nx = -hx * slope
    ny = hy * slope
    nz = np.ones_like(nx)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    n = np.stack([nx / ln, ny / ln, nz / ln], axis=-1)
    return (n * 0.5 + 0.5).astype(np.float32)


def normal_from_height(height: np.ndarray, strength: float = 0.4) -> np.ndarray:
    hx, hy = height_gradient(height)
    return normal_from_gradient(hx, hy, strength)


def blend_normals(base_rgb: np.ndarray, detail_rgb: np.ndarray,
                  detail_weight: float = 1.0) -> np.ndarray:
    """Whiteout / UDN blend. Keeps the base silhouette, adds detail slope."""
    b = base_rgb * 2.0 - 1.0
    d = detail_rgb * 2.0 - 1.0
    d[..., 0] *= detail_weight
    d[..., 1] *= detail_weight
    n = np.stack([
        b[..., 0] + d[..., 0],
        b[..., 1] + d[..., 1],
        b[..., 2] * np.maximum(d[..., 2], 0.05),
    ], axis=-1)
    ln = np.sqrt((n * n).sum(-1, keepdims=True))
    n = n / np.maximum(ln, 1e-6)
    return (n * 0.5 + 0.5).astype(np.float32)


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92,
                    ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92,
                    1.055 * c ** (1.0 / 2.4) - 0.055).astype(np.float32)


def rgb_to_hsv(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.max(rgb, axis=-1)
    mn = np.min(rgb, axis=-1)
    d = mx - mn
    h = np.zeros_like(mx)
    m = d > 1e-6
    rm = m & (mx == r)
    gm = m & (mx == g) & ~rm
    bm = m & (mx == b) & ~rm & ~gm
    h[rm] = ((g - b)[rm] / d[rm]) % 6.0
    h[gm] = ((b - r)[gm] / d[gm]) + 2.0
    h[bm] = ((r - g)[bm] / d[bm]) + 4.0
    h = h / 6.0
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0.0)
    return np.stack([h, s, mx], axis=-1).astype(np.float32)


def luminance(rgb: np.ndarray) -> np.ndarray:
    return (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]).astype(np.float32)


def box_blur(a: np.ndarray, r: int) -> np.ndarray:
    if r < 1:
        return a
    k = 2 * r + 1
    pad = np.pad(a, ((r, r), (r, r)), mode="edge")
    c = np.cumsum(np.cumsum(pad, axis=0), axis=1)
    c = np.pad(c, ((1, 0), (1, 0)), mode="constant")
    h, w = a.shape
    out = (c[k:k + h, k:k + w] - c[0:h, k:k + w]
           - c[k:k + h, 0:w] + c[0:h, 0:w]) / float(k * k)
    return out.astype(np.float32)


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    """Cheap max-filter; used to bleed maps past UV island edges so mip-mapping
    does not pull background colour into a seam."""
    out = mask.copy()
    for _ in range(r):
        out = np.maximum.reduce([
            out,
            np.roll(out, 1, 0), np.roll(out, -1, 0),
            np.roll(out, 1, 1), np.roll(out, -1, 1),
        ])
    return out


def remap(a: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return (lo + (hi - lo) * np.clip(a, 0.0, 1.0)).astype(np.float32)


# ------------------------------------------------------------------------ io

def save_gray(path: str, a: np.ndarray) -> None:
    Image.fromarray((np.clip(a, 0, 1) * 255.0 + 0.5).astype(np.uint8), "L").save(path)


def save_rgb(path: str, a: np.ndarray) -> None:
    Image.fromarray((np.clip(a, 0, 1) * 255.0 + 0.5).astype(np.uint8), "RGB").save(path)


def load_rgb(path: str, size=None) -> np.ndarray:
    im = Image.open(path).convert("RGB")
    if size is not None and im.size != tuple(size):
        im = im.resize(tuple(size), Image.LANCZOS)
    return (np.asarray(im, np.float32) / 255.0)
