#!/usr/bin/env python3
"""Halve texture resolution and decimate arena geometry.

VRAM, not disk, is the constraint on an 8GB shared-memory Air: a 2048x2048
RGBA texture occupies 16MB decoded regardless of how well the PNG compresses,
and we ship ~36 of them. Dropping to 1024 cuts that 4x and materially improves
sampler cache hit rate, which matters because the surface shader takes several
dependent samples per fragment.
"""
import os, sys, glob
from PIL import Image

TEX = 'web/public/assets/tex/arena'
SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 1024

total_before = total_after = 0
for f in sorted(glob.glob(os.path.join(TEX, '*.png'))):
    im = Image.open(f)
    if im.width <= SIZE:
        continue
    before = im.width * im.height * 4
    # Normals must not pick up ringing from a sharpening filter; LANCZOS on a
    # normal map introduces overshoot that shows up as shimmer at grazing angles.
    resample = Image.BILINEAR if '_normal' in os.path.basename(f) else Image.LANCZOS
    im = im.convert('RGB') if im.mode in ('P', 'L') else im
    im = im.resize((SIZE, SIZE), resample)
    im.save(f, optimize=True)
    total_before += before
    total_after += SIZE * SIZE * 4
    print(f'  {os.path.basename(f):28s} -> {SIZE}')

print(f'\nVRAM for these maps: {total_before/1e6:.0f}MB -> {total_after/1e6:.0f}MB')
