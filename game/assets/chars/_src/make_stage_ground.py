"""Tiling ground for the character stage's fallback lighting rig.

Only used when `scenes/world/world.tscn` is absent. It exists so the fallback is
never an untextured single-colour plane, which ART_BIBLE §12.9 calls an instant
fail, and so there is something for SDFGI to bounce warm light off.

    python3 make_stage_ground.py <out_dir>
"""
from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import texlib as T  # noqa: E402

S = 1024


def main() -> None:
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    shape = (S, S)

    grit, cell = T.voronoi(shape, 260, 3)
    pebble, pid = T.voronoi(shape, 90, 17)
    dirt = T.fbm(shape, 8, 6, 5)
    fine = T.fbm(shape, 160, 3, 9)
    crack = T.ridged(shape, 26, 4, 13)

    height = (0.45 * (1.0 - pebble) + 0.30 * (1.0 - grit) + 0.25 * fine)
    height -= np.clip(1.0 - crack * 3.0, 0, 1) * 0.35

    # Wet-dark patches: ART_BIBLE §7 wants roughness 0.2 inside a puddle mask.
    wet = np.clip((T.fbm(shape, 5, 4, 21) - 0.52) * 5.0, 0.0, 1.0)
    wet *= np.clip(1.0 - height * 1.2, 0.0, 1.0)

    base = np.array([0.20, 0.195, 0.185], np.float32)
    warm = np.array([0.30, 0.26, 0.215], np.float32)
    alb = base[None, None, :] + (warm - base)[None, None, :] * (dirt * 0.9 + pid * 0.25)[..., None]
    alb += (fine[..., None] - 0.5) * 0.05
    alb *= (0.72 + 0.45 * (1.0 - grit))[..., None]
    alb *= (1.0 - wet * 0.45)[..., None]
    alb = np.clip(alb, 0.04, 0.62)

    rough = 0.94 - 0.24 * dirt - 0.14 * (1.0 - pebble) + 0.10 * fine
    rough = rough * (1.0 - wet) + 0.20 * wet
    rough = np.clip(rough, 0.12, 1.0)

    ao = np.clip(0.55 + 0.55 * height + 0.25 * crack, 0.2, 1.0)

    nrm = T.normal_from_height(height, 2.6)
    micro = T.normal_from_height((fine - 0.5) * 0.5, 1.0)
    nrm = T.blend_normals(nrm, micro, 0.6)

    orm = np.stack([ao, rough, np.zeros_like(rough)], -1)
    T.save_rgb(os.path.join(out, "stage_ground_albedo.png"), alb)
    T.save_rgb(os.path.join(out, "stage_ground_normal.png"), nrm)
    T.save_rgb(os.path.join(out, "stage_ground_orm.png"), orm)
    print("ground written to", out)


if __name__ == "__main__":
    main()
