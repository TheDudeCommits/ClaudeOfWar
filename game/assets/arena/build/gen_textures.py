#!/usr/bin/env python3
"""Bake the arena's tiling PBR texture set.

Every material ships albedo / normal / ORM (R=AO, G=roughness, B=metallic).
Roughness is authored from its own noise fields plus cavity and wear terms --
never a constant (ART_BIBLE section 7).

    python3 gen_textures.py            # full res
    python3 gen_textures.py --fast     # half res preview
    python3 gen_textures.py --only stone,iron
"""
import argparse
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from texlib import (F32, cavity_ao, cell_id, fbm, hexrgb, mix, norm01,  # noqa: E402
                    normal_map, ridged, save_rgb, smoothstep, speckle, tint,
                    value_noise, warp, worley)

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "textures")
os.makedirs(OUT, exist_ok=True)

BIG = 2048
MID = 1024
SML = 512


def albedo_clamp(a):
    """Keep sRGB albedo inside the physically sane window (linear 0.04-0.85)."""
    return np.clip(a, 0.22, 0.94)


def warpfield(S, seed, freq=6, oct_=4):
    return (fbm(S, freq, octaves=oct_, seed=seed),
            fbm(S, freq, octaves=oct_, seed=seed + 555))


def write(name, albedo, rough, metal, height, nstrength=1.0, ao_mul=None,
          ao_sigma=22.0):
    ao = cavity_ao(height, sigma=ao_sigma)
    if ao_mul is not None:
        ao = np.clip(ao * ao_mul, 0.0, 1.0)
    if np.isscalar(metal):
        metal = np.full(height.shape, float(metal), F32)
    orm = np.dstack([ao, np.clip(rough, 0.03, 1.0), np.clip(metal, 0, 1)])
    save_rgb(albedo_clamp(albedo), os.path.join(OUT, name + "_albedo.png"))
    save_rgb(normal_map(height, nstrength), os.path.join(OUT, name + "_normal.png"))
    save_rgb(orm, os.path.join(OUT, name + "_orm.png"))


# ============================================================== materials ===
def mat_stone(S):
    """Weathered granite block face: crystalline speckle, spalled facets, lichen.

    Walls are built from individual beveled blocks in geometry, so this map must
    read as rock *surface*, not as a masonry pattern.
    """
    wy, wx = warpfield(S, 3001, freq=5)
    macro = warp(fbm(S, 4, octaves=6, seed=11), wy, wx, 0.11)
    med = warp(fbm(S, 18, octaves=5, seed=23), wy, wx, 0.05)
    fine = fbm(S, 80, octaves=4, seed=37)
    micro = fbm(S, 300, octaves=3, seed=41)
    speck = fbm(S, 500, octaves=2, seed=43)          # feldspar crystals

    spall = smoothstep(0.545, 0.605,
                       warp(fbm(S, 11, octaves=4, seed=17), wy, wx, 0.10))
    spall += 0.6 * smoothstep(0.575, 0.615,
                              warp(fbm(S, 30, octaves=3, seed=19), wy, wx, 0.05))
    spall = np.clip(spall, 0, 1)

    _, border = cell_id(S, 34, seed=5, res=min(S, 1024))
    border = warp(border, wy, wx, 0.05)
    crack = (1.0 - smoothstep(0.0, 0.0075, border)) * \
        smoothstep(0.42, 0.68, fbm(S, 10, octaves=4, seed=29))

    h = (macro * 0.30 + med * 0.26 + fine * 0.20 + micro * 0.12
         + smoothstep(0.55, 0.85, speck) * 0.07)
    h = h - spall * 0.10 - crack * 0.13
    h = norm01(h)

    lichen = smoothstep(0.60, 0.80, warp(fbm(S, 7, octaves=4, seed=61), wy, wx, 0.09)) \
        * smoothstep(0.28, 0.62, med)
    grime = smoothstep(0.25, 0.90, fbm(S, 3, octaves=4, seed=71))

    col = tint(norm01(macro * 0.55 + med * 0.45), "#585C61", "#9A968F")
    col = mix(col, hexrgb("#C2BDB3")[None, None, :],
              (smoothstep(0.62, 0.90, speck) * 0.55)[:, :, None])
    col = mix(col, hexrgb("#4C4A45")[None, None, :],
              (smoothstep(0.55, 0.95, micro) * 0.35)[:, :, None])
    col = mix(col, hexrgb("#ABA69C")[None, None, :], (spall * 0.50)[:, :, None])
    col = mix(col, hexrgb("#57644B")[None, None, :], (lichen * 0.48)[:, :, None])
    col = mix(col, hexrgb("#3B3D41")[None, None, :], (crack * 0.72)[:, :, None])
    col *= (0.84 + 0.20 * (1.0 - grime))[:, :, None]

    rough = 0.68 + fine * 0.13 + micro * 0.11
    rough = rough - crack * 0.30 - smoothstep(0.62, 0.90, speck) * 0.16
    rough = rough + lichen * 0.13 + spall * 0.05
    return dict(albedo=col, rough=np.clip(rough, 0.24, 0.96), metal=0.0,
                height=h, nstrength=1.30)


def mat_rock(S):
    """Village flagstone floor: worn slabs, gritted seams, cart scuffs, ice."""
    wy, wx = warpfield(S, 4001, freq=7)
    idv, border = cell_id(S, 22, seed=101, res=min(S, 1024))
    idv = warp(idv, wy, wx, 0.04)
    border = warp(border, wy, wx, 0.04)
    seam = 1.0 - smoothstep(0.0, 0.011, border)
    wide = 1.0 - smoothstep(0.0, 0.030, border)

    slab = (idv - 0.5) * 0.14
    med = warp(fbm(S, 14, octaves=5, seed=113), wy, wx, 0.05)
    fine = fbm(S, 65, octaves=4, seed=127)
    grit = fbm(S, 240, octaves=3, seed=131)
    gravel = smoothstep(0.54, 0.71, warp(fbm(S, 55, octaves=2, seed=137),
                                         wy, wx, 0.010))
    scuff = smoothstep(0.66, 0.93, ridged(S, 40, 3, octaves=4, seed=139))

    h = norm01(slab + med * 0.26 + fine * 0.17 + grit * 0.08
               - seam * 0.45 - wide * 0.09
               + gravel * (0.06 + 0.14 * wide))

    wet = np.clip(smoothstep(0.30, 0.90, wide) * 0.85
                  + smoothstep(0.78, 0.99, 1.0 - med) * 0.30, 0, 1)
    dust = smoothstep(0.42, 0.90, warp(fbm(S, 5, octaves=4, seed=151), wy, wx, 0.08))

    col = tint(norm01(idv * 0.5 + med * 0.5), "#50535A", "#8C877D")
    col = mix(col, hexrgb("#6E6558")[None, None, :], (dust * 0.34)[:, :, None])
    col = mix(col, hexrgb("#2E3236")[None, None, :], (wide * 0.72)[:, :, None])
    col = mix(col, hexrgb("#9B978E")[None, None, :],
              (np.clip(gravel * 0.60 + scuff * 0.28, 0, 1))[:, :, None])
    col *= (0.84 + 0.18 * fine)[:, :, None]

    rough = 0.72 + fine * 0.13 + grit * 0.09 - wet * 0.44 - scuff * 0.11
    return dict(albedo=col, rough=np.clip(rough, 0.16, 0.95), metal=0.0,
                height=h, nstrength=1.25)


def mat_snow(S):
    """Wind-packed snow: sastrugi dunes, crust fracture, granular sparkle."""
    wy, wx = warpfield(S, 5001, freq=4)
    dune = warp(fbm(S, 3, 8, octaves=5, seed=201), wy, wx, 0.14)
    lump = warp(fbm(S, 14, octaves=5, seed=211), wy, wx, 0.06)
    gran = fbm(S, 120, octaves=4, seed=223)
    micro = fbm(S, 420, octaves=3, seed=227)
    _, border = cell_id(S, 20, seed=233, res=min(S, 512))
    crust = (1.0 - smoothstep(0.0, 0.012, warp(border, wy, wx, 0.05))) * \
        smoothstep(0.45, 0.75, lump)

    h = norm01(dune * 0.50 + lump * 0.28 + gran * 0.14 + micro * 0.06
               - crust * 0.12)

    deep = smoothstep(0.45, 0.03, h)
    col = tint(norm01(lump * 0.45 + gran * 0.55), "#E9EEF5", "#FDFEFE")
    col = mix(col, hexrgb("#BFCEDF")[None, None, :], (deep * 0.42)[:, :, None])
    col = mix(col, hexrgb("#D7DDE4")[None, None, :],
              (smoothstep(0.68, 0.98, gran) * 0.16)[:, :, None])

    spark = speckle(S, 0.00030, seed=241, radius=2)
    rough = 0.60 + gran * 0.16 + micro * 0.09 - deep * 0.12 - spark * 0.45
    return dict(albedo=col, rough=np.clip(rough, 0.12, 0.92), metal=0.0,
                height=h, nstrength=0.70, ao_sigma=34.0)


def mat_timber(S):
    """Weathered structural timber. Grain runs along +U (the beam's long axis)."""
    wy, wx = warpfield(S, 6001, freq=10)
    # Grain frequency is deliberately moderate: at 130+ bands per tile the
    # fibres land near one screen pixel on a foreground post and shimmer into
    # moire under the project's negative mipmap bias.
    graw = warp(ridged(S, 82, 5, octaves=4, gain=0.42, seed=301), wy, wx, 0.004)
    fibre = smoothstep(0.58, 1.00, graw)          # raised light fibres
    fissure = smoothstep(0.40, 0.05, graw)        # dark grain fissures
    coarse = warp(fbm(S, 22, 4, octaves=4, seed=305), wy, wx, 0.015)
    fine = ridged(S, 230, 11, octaves=2, gain=0.40, seed=307)
    splits = smoothstep(0.88, 0.995, ridged(S, 34, 2, octaves=3, gain=0.45, seed=317))
    checks = smoothstep(0.93, 1.0, ridged(S, 110, 4, octaves=2, seed=323))
    adze = value_noise(S, 4, 34, seed=331)        # hewn facet marks

    knot_c, knot_b = cell_id(S, 7, seed=337, res=min(S, 512))
    knot_b = warp(knot_b, wy, wx, 0.02)
    knot = smoothstep(0.075, 0.012, knot_b) * smoothstep(0.80, 0.95, knot_c)
    knot_ring = np.abs(np.sin(knot_b * 220.0)) * knot

    h = norm01(fibre * 0.26 - fissure * 0.22 + coarse * 0.26 + fine * 0.12
               + adze * 0.08 - splits * 0.55 - checks * 0.16
               - knot * 0.22 + knot_ring * 0.08)

    weather = smoothstep(0.30, 0.88, warp(fbm(S, 5, octaves=4, seed=347), wy, wx, 0.09))
    col = tint(norm01(coarse * 0.6 + adze * 0.4), "#2E2216", "#7A6242")
    col = mix(col, hexrgb("#8A8478")[None, None, :], (weather * 0.42)[:, :, None])
    col = mix(col, hexrgb("#4C3B26")[None, None, :], (fissure * 0.62)[:, :, None])
    col = mix(col, hexrgb("#9E8F76")[None, None, :], (fibre * 0.34)[:, :, None])
    col = mix(col, hexrgb("#191410")[None, None, :],
              (np.clip(splits + checks * 0.7 + knot * 0.9, 0, 1) * 0.88)[:, :, None])
    col *= (0.86 + 0.16 * coarse)[:, :, None]

    rough = 0.78 + fine * 0.11 + weather * 0.09 - knot * 0.24 - fibre * 0.10 \
        + fissure * 0.07
    return dict(albedo=col, rough=np.clip(rough, 0.32, 0.97), metal=0.0,
                height=h, nstrength=1.20)


def mat_plank(S):
    """Sawn pale boards for crates, barrels, shutters. Seams every 1/8 of V."""
    v = np.tile((np.arange(S, dtype=F32) / S)[:, None], (1, S))
    boards = 8.0
    bi = np.floor(v * boards)
    bf = v * boards - bi
    seam = smoothstep(0.040, 0.0, bf) + smoothstep(0.960, 1.0, bf)
    rng = np.random.default_rng(401)
    per_board = np.take(rng.random(int(boards)).astype(F32),
                        bi.astype(np.int32) % int(boards))

    wy, wx = warpfield(S, 7001, freq=9)
    grain = warp(ridged(S, 70, 3, octaves=5, seed=409), wy, wx, 0.010)
    coarse = fbm(S, 20, 4, octaves=4, seed=421)
    fine = ridged(S, 280, 8, octaves=3, seed=419)
    nail = speckle(S, 0.00007, seed=431, radius=4)

    h = norm01(grain * 0.38 + coarse * 0.24 + fine * 0.16 + per_board * 0.08
               - seam * 0.80 - nail * 0.30)

    col = tint(norm01(grain * 0.5 + coarse * 0.5), "#54402A", "#A38A5C")
    col *= (0.78 + 0.34 * per_board)[:, :, None]
    col = mix(col, hexrgb("#211A11")[None, None, :], (seam * 0.92)[:, :, None])
    col = mix(col, hexrgb("#726A5E")[None, None, :],
              (smoothstep(0.45, 0.9, coarse) * 0.34)[:, :, None])
    col = mix(col, hexrgb("#8E9298")[None, None, :], (nail * 0.9)[:, :, None])

    rough = 0.72 + fine * 0.13 + coarse * 0.09 - nail * 0.32
    return dict(albedo=col, rough=np.clip(rough, 0.28, 0.95),
                metal=np.clip(nail, 0, 1), height=h, nstrength=1.10)


def mat_iron(S):
    """Forged iron: hammer facets, drawn scratches, rust bloom (metallic -> 0)."""
    wy, wx = warpfield(S, 8001, freq=6)
    facet = warp(fbm(S, 20, octaves=4, seed=501), wy, wx, 0.05)
    dents = smoothstep(0.58, 0.74, warp(fbm(S, 46, octaves=3, seed=509), wy, wx, 0.03))
    scr = smoothstep(0.82, 1.0, ridged(S, 400, 6, octaves=3, seed=521))
    scr2 = smoothstep(0.86, 1.0, ridged(S, 8, 300, octaves=3, seed=525))
    scratch = np.clip(scr + scr2 * 0.6, 0, 1)
    micro = fbm(S, 340, octaves=3, seed=523)

    rust_m = smoothstep(0.44, 0.78, warp(fbm(S, 7, octaves=5, seed=541), wy, wx, 0.12))
    pit = smoothstep(0.55, 0.80, fbm(S, 110, octaves=3, seed=547)) * rust_m

    h = norm01(facet * 0.34 - dents * 0.26 + scratch * 0.08 + micro * 0.10
               + rust_m * 0.10 - pit * 0.30)

    steel = tint(norm01(facet * 0.55 + micro * 0.45), "#53575C", "#A2A8AE")
    rust = tint(norm01(pit * 0.5 + facet * 0.5), "#4C352A", "#7C5B3E")
    col = mix(steel, rust, np.clip(rust_m * 1.05, 0, 1)[:, :, None])
    col = mix(col, hexrgb("#2C2E31")[None, None, :], (dents * 0.32)[:, :, None])
    col = mix(col, hexrgb("#C9CDD2")[None, None, :], (scratch * 0.30 * (1 - rust_m))[:, :, None])

    rough = 0.40 + facet * 0.13 + micro * 0.09 - scratch * 0.18 + dents * 0.06
    rough = mix(rough, 0.86 + pit * 0.10, rust_m)
    metal = np.clip(1.0 - rust_m * 1.15, 0, 1)
    return dict(albedo=col, rough=np.clip(rough, 0.14, 0.96), metal=metal,
                height=h, nstrength=1.05)


def mat_cloth(S):
    """Heavy dyed wool banner: visible weave, sun bleach, soot, tattered wear."""
    warpline = np.abs(np.sin(np.linspace(0, np.pi * 210, S, dtype=F32)))
    weft = warpline.copy()
    checker = ((np.arange(S)[None, :] // 5 + np.arange(S)[:, None] // 5) % 2).astype(F32)
    weave = mix(np.tile(warpline[None, :], (S, 1)),
                np.tile(weft[:, None], (1, S)), checker)
    slub = fbm(S, 50, octaves=3, seed=601)
    fade = fbm(S, 3, octaves=4, seed=607)
    dirt = smoothstep(0.42, 0.92, fbm(S, 7, octaves=5, seed=613))
    wear = smoothstep(0.70, 0.96, fbm(S, 14, octaves=4, seed=617))

    h = norm01(weave * 0.52 + slub * 0.26 + fade * 0.12 - wear * 0.34)

    col = tint(norm01(fade * 0.7 + slub * 0.3), "#6B2A20", "#AA5636")
    col = mix(col, hexrgb("#C9A227")[None, None, :],
              (smoothstep(0.60, 0.74, fade) * 0.38)[:, :, None])
    col = mix(col, hexrgb("#3A3129")[None, None, :], (dirt * 0.56)[:, :, None])
    col *= (0.80 + 0.22 * weave)[:, :, None]

    rough = 0.80 + slub * 0.13 - weave * 0.11 + dirt * 0.06
    return dict(albedo=col, rough=np.clip(rough, 0.45, 0.98), metal=0.0,
                height=h, nstrength=0.85)


def mat_thatch(S):
    """Straw / reed roof for the far-plane longhouses. Strands run down V."""
    wy, wx = warpfield(S, 9001, freq=6)
    strand = warp(ridged(S, 6, 190, octaves=4, seed=701), wy, wx, 0.010)
    bundle = fbm(S, 5, 26, octaves=4, seed=709)
    rows = np.tile(np.abs(np.sin(np.linspace(0, np.pi * 9, S, dtype=F32)))[:, None],
                   (1, S))
    fine = ridged(S, 12, 460, octaves=3, seed=719)
    h = norm01(strand * 0.40 + bundle * 0.22 + rows * 0.24 + fine * 0.14)
    moss = smoothstep(0.58, 0.86, warp(fbm(S, 8, octaves=4, seed=727), wy, wx, 0.08))
    col = tint(norm01(strand * 0.5 + bundle * 0.5), "#3A3225", "#8D7749")
    col = mix(col, hexrgb("#4C5637")[None, None, :], (moss * 0.52)[:, :, None])
    rough = 0.86 + fine * 0.10 - moss * 0.07
    return dict(albedo=col, rough=np.clip(rough, 0.55, 0.99), metal=0.0,
                height=h, nstrength=1.05)


def mat_rope(S):
    """Twisted hemp - diagonal lay, frayed fibres."""
    x = np.arange(S, dtype=F32)[None, :] / S
    y = np.arange(S, dtype=F32)[:, None] / S
    lay = np.abs(np.sin((x * 3.0 + y * 22.0) * np.pi))
    lay2 = np.abs(np.sin((x * 3.0 - y * 22.0) * np.pi)) * 0.35
    fibre = ridged(S, 22, 130, octaves=3, seed=801)
    h = norm01(lay * 0.58 + lay2 * 0.14 + fibre * 0.28)
    col = tint(norm01(lay * 0.55 + fibre * 0.45), "#463B27", "#9C8C63")
    rough = 0.84 + fibre * 0.12 - lay * 0.06
    return dict(albedo=col, rough=np.clip(rough, 0.55, 0.99), metal=0.0,
                height=h, nstrength=1.15)


def mat_bark(S):
    """Dead conifer bark: deep vertical fissures, flaking plates. Runs down V."""
    wy, wx = warpfield(S, 10001, freq=7)
    fis = warp(ridged(S, 5, 46, octaves=5, seed=901), wy, wx, 0.03)
    plate_c, plate_b = cell_id(S, 260, seed=907, res=min(S, 1024))
    plate = smoothstep(0.0, 0.022, warp(plate_b, wy, wx, 0.02))
    fine = ridged(S, 20, 220, octaves=4, seed=911)
    h = norm01(fis * 0.46 + plate * 0.24 + fine * 0.20 + plate_c * 0.10)
    col = tint(norm01(fis * 0.55 + plate_c * 0.45), "#211A13", "#6D5E49")
    col = mix(col, hexrgb("#948D7E")[None, None, :],
              (smoothstep(0.72, 0.96, fine) * 0.32)[:, :, None])
    rough = 0.82 + fine * 0.14 - plate * 0.05
    return dict(albedo=col, rough=np.clip(rough, 0.5, 0.99), metal=0.0,
                height=h, nstrength=1.50)


def mat_dirt(S):
    """Frozen churned mud: clods, grit, boot ruts, thin ice glaze in hollows."""
    wy, wx = warpfield(S, 11001, freq=6)
    lumps = warp(fbm(S, 12, octaves=5, seed=1001), wy, wx, 0.07)
    fine = fbm(S, 70, octaves=4, seed=1009)
    peb = smoothstep(0.60, 0.76, fbm(S, 210, octaves=3, seed=1013))
    ruts = ridged(S, 24, 3, octaves=3, seed=1019)
    h = norm01(lumps * 0.42 + fine * 0.22 + peb * 0.18 + ruts * 0.18)
    ice = smoothstep(0.28, 0.0, h) * smoothstep(0.35, 0.72, lumps)
    col = tint(norm01(lumps * 0.6 + fine * 0.4), "#302820", "#6E5F48")
    col = mix(col, hexrgb("#918D84")[None, None, :], (peb * 0.58)[:, :, None])
    col = mix(col, hexrgb("#5E6B78")[None, None, :], (ice * 0.52)[:, :, None])
    rough = 0.80 + fine * 0.13 - ice * 0.55 - peb * 0.07
    return dict(albedo=col, rough=np.clip(rough, 0.15, 0.97), metal=0.0,
                height=h, nstrength=1.15)


# ---------------------------------------------------------------- helpers ---
def gen_macro(S=512):
    """Low-frequency multiplier the ground shader uses to break up tiling."""
    a = fbm(S, 3, octaves=5, gain=0.55, seed=2001)
    b = fbm(S, 8, octaves=4, seed=2011)
    m = np.clip(norm01(a * 0.65 + b * 0.35) * 0.75 + 0.25, 0, 1)
    save_rgb(m, os.path.join(OUT, "macro_variation.png"))


def gen_detail_normal(S=1024):
    """8-20x tiling micro-detail normal overlay (ART_BIBLE section 7)."""
    g = fbm(S, 90, octaves=4, seed=3001)
    grit = smoothstep(0.58, 0.74, fbm(S, 260, octaves=3, seed=3011))
    scr = smoothstep(0.88, 1.0, ridged(S, 300, 40, octaves=2, seed=3021))
    h = norm01(g * 0.5 + grit * 0.38 + scr * 0.12)
    save_rgb(normal_map(h, 0.50), os.path.join(OUT, "detail_normal.png"))


def gen_sprites():
    """Soft radial particle sprites for drifting snow and brazier embers."""
    from PIL import Image
    for name, col, S, p in (("flake", (1.0, 1.0, 1.0), 128, 1.9),
                            ("ember", (1.0, 0.62, 0.28), 64, 2.6)):
        yy, xx = np.mgrid[0:S, 0:S].astype(F32)
        c = (S - 1) * 0.5
        d = np.sqrt((xx - c) ** 2 + (yy - c) ** 2) / c
        a = np.clip(1.0 - d, 0.0, 1.0) ** p
        rgb = np.dstack([np.full((S, S), col[i], F32) for i in range(3)])
        img = np.dstack([rgb, a])
        Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8),
                        "RGBA").save(os.path.join(OUT, name + ".png"))


MATERIALS = [
    ("stone", mat_stone, BIG),
    ("rock", mat_rock, BIG),
    ("snow", mat_snow, BIG),
    ("timber", mat_timber, BIG),
    ("plank", mat_plank, MID),
    ("iron", mat_iron, MID),
    ("cloth", mat_cloth, MID),
    ("thatch", mat_thatch, MID),
    ("rope", mat_rope, SML),
    ("bark", mat_bark, MID),
    ("dirt", mat_dirt, MID),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true", help="half-res preview bake")
    ap.add_argument("--only", default="", help="comma separated material names")
    a = ap.parse_args()
    only = set(x.strip() for x in a.only.split(",") if x.strip())
    t0 = time.time()
    for name, fn, size in MATERIALS:
        if only and name not in only:
            continue
        s = max(256, size // 2) if a.fast else size
        t = time.time()
        write(name, **fn(s))
        print(f"  {name:8s} @{s:5d}  {time.time() - t:5.1f}s")
    if not only or "sprites" in only:
        gen_sprites()
        print("  flake + ember sprites")
    if not only:
        gen_macro(256 if a.fast else 512)
        gen_detail_normal(512 if a.fast else 1024)
        print("  macro_variation + detail_normal")
    print(f"done in {time.time() - t0:.1f}s -> {OUT}")


if __name__ == "__main__":
    main()
