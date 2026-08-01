"""Tiling procedural texture primitives (numpy).

Everything here is periodic on [0,1)^2 so the resulting maps tile seamlessly.
Noise is multi-octave value noise; cracks/cells come from a toroidal Worley
distance field; normals are Sobel-derived from a height field; AO is a cavity
approximation (blurred height minus height).
"""
import numpy as np
from PIL import Image

F32 = np.float32


# ---------------------------------------------------------------- lattice ---
def _axis(freq: int, size: int):
    """Return (i0, i1, t) index/weight arrays for a wrapping smooth upsample."""
    x = np.arange(size, dtype=F32) * (freq / float(size))
    f = np.floor(x)
    i0 = f.astype(np.int32) % freq
    i1 = (i0 + 1) % freq
    t = (x - f).astype(F32)
    t = t * t * (3.0 - 2.0 * t)          # smoothstep -> C1 continuous
    return i0, i1, t


def value_noise(size: int, fy: int, fx: int, seed: int) -> np.ndarray:
    """Tiling value noise with independent vertical/horizontal frequency."""
    fy = max(1, int(fy))
    fx = max(1, int(fx))
    rng = np.random.default_rng(seed)
    g = rng.random((fy, fx)).astype(F32)
    iy0, iy1, ty = _axis(fy, size)
    ix0, ix1, tx = _axis(fx, size)
    a = g[np.ix_(iy0, ix0)]
    b = g[np.ix_(iy0, ix1)]
    c = g[np.ix_(iy1, ix0)]
    d = g[np.ix_(iy1, ix1)]
    ux = tx[None, :]
    uy = ty[:, None]
    top = a + (b - a) * ux
    bot = c + (d - c) * ux
    return (top + (bot - top) * uy).astype(F32)


def fbm(size, fy, fx=None, octaves=6, gain=0.5, lac=2.0, seed=0):
    """Fractal value noise with explicit per-axis base frequency.

    fy < fx  -> features long in Y (vertical streaks / palisade logs)
    fy > fx  -> features long in X (wood grain along a beam)
    """
    fx = fy if fx is None else fx
    out = np.zeros((size, size), F32)
    amp, norm = 1.0, 0.0
    a, b = float(fy), float(fx)
    for o in range(octaves):
        out += amp * value_noise(size, int(round(a)), int(round(b)), seed + o * 1013)
        norm += amp
        amp *= gain
        a *= lac
        b *= lac
        if max(a, b) > size * 0.5:
            break
    return out / norm


def ridged(size, fy, fx=None, octaves=5, gain=0.5, lac=2.0, seed=0):
    """Ridged multifractal - crack, vein, fibre and bark structure."""
    fx = fy if fx is None else fx
    out = np.zeros((size, size), F32)
    amp, norm = 1.0, 0.0
    a, b = float(fy), float(fx)
    for o in range(octaves):
        n = value_noise(size, int(round(a)), int(round(b)), seed + o * 733)
        out += amp * (1.0 - np.abs(n * 2.0 - 1.0))
        norm += amp
        amp *= gain
        a *= lac
        b *= lac
        if max(a, b) > size * 0.5:
            break
    return out / norm


def warp(field, dy, dx, amount):
    """Domain-warp `field` by two noise fields. Kills the 'camo blob' look that
    thresholded smooth noise otherwise produces, and it stays tiling."""
    n = field.shape[0]
    yy = np.arange(n, dtype=F32)[:, None] + (dy - 0.5) * (amount * n)
    xx = np.arange(n, dtype=F32)[None, :] + (dx - 0.5) * (amount * n)
    yy = np.broadcast_to(yy, (n, n))
    xx = np.broadcast_to(xx, (n, n))
    y0 = np.floor(yy).astype(np.int32)
    x0 = np.floor(xx).astype(np.int32)
    ty = (yy - y0).astype(F32)
    tx = (xx - x0).astype(F32)
    y0 %= n
    x0 %= n
    y1 = (y0 + 1) % n
    x1 = (x0 + 1) % n
    a = field[y0, x0]
    b = field[y0, x1]
    c = field[y1, x0]
    d = field[y1, x1]
    top = a + (b - a) * tx
    bot = c + (d - c) * tx
    return (top + (bot - top) * ty).astype(F32)


def worley(size, npts, seed, res=None):
    """Toroidal Worley. Returns (F1, F2) distance fields, both in [0,~0.7]."""
    r = res or min(size, 1024)
    rng = np.random.default_rng(seed)
    pts = rng.random((int(npts), 2)).astype(F32)
    yy = (np.arange(r, dtype=F32) / r)[:, None]
    xx = (np.arange(r, dtype=F32) / r)[None, :]
    d1 = np.full((r, r), 9.0, F32)
    d2 = np.full((r, r), 9.0, F32)
    for py, px in pts:
        dy = np.abs(yy - py)
        dy = np.minimum(dy, 1.0 - dy)
        dx = np.abs(xx - px)
        dx = np.minimum(dx, 1.0 - dx)
        d = np.sqrt(dy * dy + dx * dx)
        m = d < d1
        d2 = np.where(m, d1, np.minimum(d2, d))
        d1 = np.where(m, d, d1)
    if r != size:
        d1 = resize(d1, size)
        d2 = resize(d2, size)
    return d1, d2


def cell_id(size, npts, seed, res=None):
    """Per-cell random value (flat slab tinting) + F2-F1 border field."""
    r = res or min(size, 1024)
    rng = np.random.default_rng(seed)
    pts = rng.random((int(npts), 2)).astype(F32)
    vals = rng.random(int(npts)).astype(F32)
    yy = (np.arange(r, dtype=F32) / r)[:, None]
    xx = (np.arange(r, dtype=F32) / r)[None, :]
    d1 = np.full((r, r), 9.0, F32)
    d2 = np.full((r, r), 9.0, F32)
    idv = np.zeros((r, r), F32)
    for k, (py, px) in enumerate(pts):
        dy = np.abs(yy - py)
        dy = np.minimum(dy, 1.0 - dy)
        dx = np.abs(xx - px)
        dx = np.minimum(dx, 1.0 - dx)
        d = np.sqrt(dy * dy + dx * dx)
        m = d < d1
        d2 = np.where(m, d1, np.minimum(d2, d))
        d1 = np.where(m, d, d1)
        idv = np.where(m, vals[k], idv)
    border = d2 - d1
    if r != size:
        idv = resize(idv, size, nearest=True)
        border = resize(border, size)
    return idv, border


# ------------------------------------------------------------------ utils ---
def resize(a, size, nearest=False):
    im = Image.fromarray(a.astype(np.float32), mode="F")
    im = im.resize((size, size), Image.NEAREST if nearest else Image.BICUBIC)
    return np.asarray(im, dtype=F32)


def gauss(a, sigma):
    """Periodic gaussian blur via FFT (matches the tiling domain exactly)."""
    n = a.shape[0]
    fy = np.fft.fftfreq(n).astype(np.float32)[:, None]
    fx = np.fft.fftfreq(n).astype(np.float32)[None, :]
    k = np.exp(-2.0 * (np.pi ** 2) * (sigma ** 2) * (fx * fx + fy * fy))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * k)).astype(F32)


def norm01(a):
    lo, hi = float(a.min()), float(a.max())
    return (a - lo) / max(1e-6, hi - lo)


def smoothstep(e0, e1, x):
    """GLSL smoothstep. Handles e1 < e0 (reversed ramp) correctly."""
    d = float(e1) - float(e0)
    if abs(d) < 1e-9:
        return (np.asarray(x) >= e1).astype(F32)
    t = np.clip((x - e0) / d, 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(F32)


def mix(a, b, t):
    return a + (b - a) * t


def hexrgb(s):
    s = s.lstrip("#")
    return np.array([int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=F32)


def tint(mask, c_lo, c_hi):
    """Blend two hex colours by a scalar mask -> HxWx3."""
    a = hexrgb(c_lo)[None, None, :]
    b = hexrgb(c_hi)[None, None, :]
    return a + (b - a) * mask[:, :, None]


def speckle(size, density, seed, radius=1):
    """Sparse bright dots (grit, sparkle, rivets)."""
    rng = np.random.default_rng(seed)
    m = (rng.random((size, size)) < density).astype(F32)
    if radius > 1:
        m = np.clip(gauss(m, radius * 0.45) * (radius * radius * 2.4), 0, 1)
    return m


# ------------------------------------------------------------------- maps ---
def normal_map(h, strength=1.0):
    """Sobel normal. Godot wants X+, Y-, Z+ (DirectX-style green channel)."""
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    s = strength * (h.shape[0] / 48.0)
    nx = -gx * s
    ny = gy * s
    nz = np.ones_like(h)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.dstack([nx / l * 0.5 + 0.5, ny / l * 0.5 + 0.5, nz / l * 0.5 + 0.5])


def cavity_ao(h, sigma=22.0, k=2.6, floor=0.30):
    lo = gauss(h, sigma)
    ao = 1.0 - np.clip((lo - h) * k, 0.0, 1.0)
    lo2 = gauss(h, sigma * 4.0)
    ao *= 1.0 - np.clip((lo2 - h) * k * 0.5, 0.0, 1.0) * 0.6
    return np.clip(ao * (1.0 - floor) + floor, 0.0, 1.0)


def save_rgb(a, path):
    if a.ndim == 2:
        a = np.dstack([a, a, a])
    Image.fromarray((np.clip(a, 0, 1) * 255.0 + 0.5).astype(np.uint8)).save(path)
    return path
