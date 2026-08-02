#!/usr/bin/env python3
"""PNG -> WebP for all runtime textures.

Download size is the constraint here, not VRAM (the GPU sees decoded RGBA
either way). Normal maps go lossless: WebP's lossy chroma handling shifts the
XY channels enough to visibly wobble a specular highlight at grazing angles.
"""
import glob, os
from PIL import Image

DIRS = ['web/public/assets/tex/arena', 'web/public/assets/chars']
before = after = 0
for d in DIRS:
    for f in sorted(glob.glob(os.path.join(d, '*.png'))):
        out = f[:-4] + '.webp'
        im = Image.open(f).convert('RGBA' if 'RGBA' in Image.open(f).mode else 'RGB')
        lossless = '_normal' in os.path.basename(f)
        im.save(out, 'WEBP', lossless=lossless, quality=95 if lossless else 90, method=6)
        b, a = os.path.getsize(f), os.path.getsize(out)
        before += b; after += a
        os.remove(f)
        print(f'  {os.path.basename(f):32s} {b/1e6:6.2f}MB -> {a/1e6:5.2f}MB'
              + ('  (lossless)' if lossless else ''))
print(f'\ntotal {before/1e6:.1f}MB -> {after/1e6:.1f}MB  ({after/before*100:.0f}%)')
