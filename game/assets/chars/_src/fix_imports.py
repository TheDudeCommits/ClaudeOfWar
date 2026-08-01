"""Reapply character texture import settings.

Godot's defaults for a PNG are `mipmaps/generate=false`, which aliases badly the
moment a face fills a third of the frame, and it has no way to know that
`normal.png` is a normal map rather than colour. The project's .gitignore
excludes `*.import`, so run this after any fresh checkout / reimport:

    python3 game/assets/chars/_src/fix_imports.py
    tools/Godot.app/Contents/MacOS/Godot --path game --headless --import

What it sets:
  mipmaps/generate      true   — anisotropic filtering needs mip chains
  compress/normal_map   1      — normal maps are not colour data
  roughness/mode        1      — build roughness mips from the normal map's
                                 variance, which is the cheapest real fix for
                                 specular aliasing on a close-up
  detect_3d/compress_to 0      — stop Godot silently reimporting on first 3D use
"""
from __future__ import annotations

import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # assets/chars

DIRS = [
    ("hero", "res://assets/chars/hero/normal.png"),
    ("zombie", "res://assets/chars/zombie/normal.png"),
    ("tex", "res://assets/chars/tex/stage_ground_normal.png"),
]


def patch(path: str, **kv) -> None:
    s = open(path).read()
    for k, v in kv.items():
        pat = re.compile(r"^%s=.*$" % re.escape(k), re.M)
        line = "%s=%s" % (k, v)
        s = pat.sub(line, s) if pat.search(s) else s.rstrip() + "\n" + line + "\n"
    open(path, "w").write(s)


def main() -> int:
    n = 0
    for sub, norm in DIRS:
        d = os.path.join(ROOT, sub)
        for imp in sorted(glob.glob(os.path.join(d, "*.png.import"))):
            base = os.path.basename(imp)
            kv = {"mipmaps/generate": "true", "detect_3d/compress_to": "0"}
            if "normal" in base:
                kv["compress/normal_map"] = "1"
            elif "roughness" in base or base.startswith("stage_ground_orm"):
                kv["roughness/mode"] = "1"
                kv["roughness/src_normal"] = '"%s"' % norm
            patch(imp, **kv)
            n += 1
    print("patched %d import files" % n)
    if n == 0:
        print("none found — run Godot --import once first so they exist")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
