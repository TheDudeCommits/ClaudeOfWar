#!/usr/bin/env python3
"""
Procedural detail-normal maps for the character shaders.

All three maps are seamlessly tileable (built from band-limited periodic noise
via an FFT filter), so they can be sampled at high tiling rates or in a
non-UV frame without seams.

  hair_strand_normal.png   directional strand ridges, +U across strand,
                           +V along strand. NOT isotropic noise — the whole
                           point is that the gradient is dominated by one axis.
  skin_pores_normal.png    pore-scale dimples + fine crepe.
  leather_grain_normal.png mottled cracked grain.

Run:  python3 gen_char_detail.py
"""
import numpy as np
from PIL import Image
import os

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(20260801)


def periodic_noise(h, w, fx, fy, seed=None):
    """Band-limited tileable noise: white noise low-passed in the Fourier domain."""
    r = np.random.default_rng(seed) if seed is not None else rng
    n = r.standard_normal((h, w))
    F = np.fft.fft2(n)
    ky = np.fft.fftfreq(h) * h
    kx = np.fft.fftfreq(w) * w
    KX, KY = np.meshgrid(kx, ky)
    # anisotropic gaussian low-pass: keeps up to fx cycles across, fy along
    G = np.exp(-((KX / max(fx, 1e-3)) ** 2 + (KY / max(fy, 1e-3)) ** 2))
    out = np.real(np.fft.ifft2(F * G))
    out -= out.min()
    mx = out.max()
    return out / mx if mx > 0 else out


def fbm(h, w, f, octaves=4, gain=0.5, seed=0):
    acc = np.zeros((h, w))
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        acc += amp * periodic_noise(h, w, f * (2 ** o), f * (2 ** o), seed=seed + o)
        tot += amp
        amp *= gain
    return acc / tot


def to_normal(height, strength=1.0, name='out.png'):
    """Central-difference gradient with wraparound -> tangent-space normal map."""
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(height)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    img = ((n * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)
    Image.fromarray(img).save(os.path.join(HERE, name))
    # report how directional the map is; hair must be strongly anisotropic
    print(f'{name}: |dx|={np.abs(dx).mean():.4f} |dy|={np.abs(dy).mean():.4f} '
          f'ratio={np.abs(dx).mean() / max(np.abs(dy).mean(), 1e-9):.2f}')


# ---------------------------------------------------------------- hair
def hair_strands(size=1024, strands=64):
    h = w = size
    X = np.arange(w)[None, :] / w
    # slow lateral warp so strand columns wander instead of ruling straight lines
    warp = (periodic_noise(h, w, 3, 5, seed=11) - 0.5)
    warp2 = (periodic_noise(h, w, 1.5, 2.5, seed=12) - 0.5)
    s = X * strands + warp * 1.6 + warp2 * 3.2
    f = s - np.floor(s)
    idx = np.floor(s).astype(np.int64) % strands

    amp = np.random.default_rng(7).uniform(0.35, 1.0, strands)[idx]
    # half-cylinder cross-section -> proper rounded strand, not a sine
    prof = np.sqrt(np.clip(1.0 - (2.0 * f - 1.0) ** 2, 0, 1))
    height = prof * amp

    # sub-strands: a second, finer bundle riding on top
    s2 = X * (strands * 3) + warp * 4.0
    f2 = s2 - np.floor(s2)
    height += 0.22 * np.sqrt(np.clip(1.0 - (2.0 * f2 - 1.0) ** 2, 0, 1))

    # break strands along their length so they read as hair, not corduroy
    fade = periodic_noise(h, w, 22, 2.0, seed=13)
    height *= 0.55 + 0.75 * fade
    # fine scratch detail, stretched hard along V
    height += 0.10 * periodic_noise(h, w, 140, 6, seed=14)
    height -= height.mean()
    to_normal(height, strength=9.0, name='hair_strand_normal.png')


# ---------------------------------------------------------------- skin
def skin_pores(size=512):
    h = w = size
    base = fbm(h, w, 26, octaves=4, gain=0.55, seed=101) - 0.5
    # sparse pore dimples
    pr = np.random.default_rng(5).random((h, w))
    pores = (pr > 0.988).astype(float)
    pores = periodic_noise(h, w, 190, 190, seed=102) * 0.0 + pores
    # blur the impulses into round dimples
    F = np.fft.fft2(pores)
    ky = np.fft.fftfreq(h) * h
    kx = np.fft.fftfreq(w) * w
    KX, KY = np.meshgrid(kx, ky)
    F *= np.exp(-((KX / 150.0) ** 2 + (KY / 150.0) ** 2))
    pores = np.real(np.fft.ifft2(F))
    pores /= max(pores.max(), 1e-6)
    height = base * 0.45 - pores * 1.0
    # crepe: very fine directional creases
    height += 0.18 * (fbm(h, w, 60, octaves=3, seed=103) - 0.5)
    to_normal(height, strength=5.0, name='skin_pores_normal.png')


# ---------------------------------------------------------------- leather
def leather_grain(size=512):
    h = w = size
    cells = fbm(h, w, 14, octaves=4, gain=0.5, seed=201)
    # ridged transform gives the cracked-cell look of grained leather
    ridged = 1.0 - np.abs(cells * 2.0 - 1.0)
    ridged = ridged ** 2.2
    fine = fbm(h, w, 55, octaves=3, gain=0.55, seed=202) - 0.5
    height = ridged * 0.8 + fine * 0.35
    height -= height.mean()
    to_normal(height, strength=6.0, name='leather_grain_normal.png')


if __name__ == '__main__':
    hair_strands()
    skin_pores()
    leather_grain()
    print('wrote detail maps to', HERE)
