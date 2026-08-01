"""Procedurally build the Nordic ruined-village arena and export it as GLB.

    /opt/homebrew/bin/blender --background --python build_arena.py

Authoring space (see kitlib): +X east, +Y NORTH, +Z up.
Godot receives  gx = X, gy = Z, gz = -Y, so Godot's -Z is north.

Output: one GLB per material into ../ (game/assets/arena/), each holding a
single merged mesh named `arena_<material>`. Godot binds the real
StandardMaterial3D / ShaderMaterial by name at scene setup.
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kitlib import (Acc, Group, M, Part, bevel, bm_part, box, build_object,  # noqa: E402
                    cyl, dome_bm, export_glb, grid_bm, jitter, rock_bm,
                    tube_path, wipe_scene)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)

MATS = ["ground", "stone", "timber", "plank", "iron", "cloth", "snow",
        "rope", "thatch", "bark", "dirt"]
W = {m: Acc("arena_" + m) for m in MATS}

TAU = math.pi * 2.0
R = random.Random(20260731)


def ss(a, b, x):
    if a == b:
        return 0.0 if x < a else 1.0
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def n2(x, y, f, o=0.0):
    return noise.noise(Vector((x * f + o, y * f - o, o * 0.37)))


# ============================================================== terrain =====
def terrain(x, y):
    """World height. Flat combat bowl, rising berm, distant ridges."""
    r = math.sqrt(x * x + y * y)
    cheb = max(abs(x), abs(y))
    z = n2(x, y, 0.055, 3.1) * 0.16 + n2(x, y, 0.16, 11.7) * 0.06
    z += ss(10.5, 24.0, cheb) * 1.9
    z += ss(24.0, 62.0, r) * 6.5
    z += ss(55.0, 135.0, r) * 26.0
    z += ss(120.0, 240.0, r) * 46.0
    # north valley: the ground drops away past the gate so the far plane reads
    z -= ss(20.0, 46.0, y) * ss(0.0, 26.0, 26.0 - abs(x) * 0.55) * 3.2
    return z


def terrain_fine(x, y):
    cheb = max(abs(x), abs(y))
    fade = 1.0 - ss(20.0, 24.0, cheb)
    d = n2(x, y, 0.55, 21.3) * 0.055 + n2(x, y, 1.7, 5.9) * 0.022
    return terrain(x, y) + d * fade


def path_dist(x, y):
    """Distance to the trodden route: south entry -> gate, branch to the hall."""
    segs = [((0.5, -12.0), (-0.5, 2.0)), ((-0.5, 2.0), (0.2, 13.5)),
            ((-0.2, 3.0), (9.5, 2.2)), ((0.0, -4.0), (-7.5, -7.0))]
    best = 1e9
    for (ax, ay), (bx, by) in segs:
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L2))
        px, py = ax + dx * t, ay + dy * t
        best = min(best, math.hypot(x - px, y - py))
    return best


def snow_mask(x, y):
    cheb = max(abs(x), abs(y))
    m = 0.62 + n2(x, y, 0.22, 7.7) * 0.30 + n2(x, y, 0.8, 2.3) * 0.12
    m -= ss(2.6, 0.6, path_dist(x, y)) * 0.85          # scuffed to bare stone
    m += ss(8.5, 13.0, cheb) * 0.45                    # drifts against the ruins
    m += ss(24.0, 40.0, cheb) * 0.5
    return max(0.0, min(1.0, m))


# ========================================================= vertex colour =====
def grime(wp, tint=1.0):
    """Contact grime / self-shadow baked to vertex colour (albedo multiply)."""
    g = 0.66 + 0.34 * ss(0.02, 1.30, wp.z)
    g *= 0.92 + 0.08 * (noise.noise(wp * 0.6) * 0.5 + 0.5)
    g *= 0.94 + 0.06 * (noise.noise(wp * 2.7) * 0.5 + 0.5)
    v = max(0.30, min(1.0, g * tint))
    return (v, v, v)


def ground_col(wp, tint=1.0):
    """R = snow coverage (read by the ground shader), G = macro grime."""
    s = snow_mask(wp.x, wp.y)
    g = 0.80 + 0.20 * (noise.noise(wp * 0.10) * 0.5 + 0.5)
    return (s, g, 1.0)


def stamp(group, mat_default=None, Mw=None, tint=1.0):
    Mw = Mw if Mw is not None else Matrix.Identity(4)
    for mat, part, Mi in group.items:
        m = mat or mat_default
        W[m].stamp(part, Mw @ Mi, ground_col if m == "ground" else grime, tint)


# ============================================================== modules =====
def stone_block(w, d, h, seed, uvs=0.45, seg=1, bev=0.032):
    rng = random.Random(seed)
    bm = box(w, d, h, bev=bev, seg=seg, jit=0.010, rng=rng)
    return bm_part(bm, uvscale=uvs, uvoff=(rng.random(), rng.random()),
                   uvrot=rng.choice([0.0, math.pi * 0.5]))


def profile_fn(seed, n=6):
    rng = random.Random(seed)
    ks = [(rng.uniform(0.6, 2.4), rng.uniform(0, TAU), rng.uniform(0.3, 1.0))
          for _ in range(n)]
    def f(t):
        v = 0.0
        for fq, ph, a in ks:
            v += math.sin(t * fq * TAU + ph) * a
        return v / sum(k[2] for k in ks)
    return f


def mod_wall(length, height, thick, seed, broken=0.55, course=0.42, snow=0.85,
             gap=0.02):
    """A run of ashlar courses with a collapsed, snow-capped top profile."""
    g = Group()
    rng = random.Random(seed)
    prof = profile_fn(seed + 7)
    ncourse = max(1, int(round(height / course)))
    tops = {}          # column bucket -> (top z, block width, depth, centre x)
    for j in range(ncourse):
        z0 = j * course
        x = -length * 0.5
        off = rng.uniform(0.0, 0.6)
        x += off
        if off > 0.05:
            wfirst = off
            g.add("stone", stone_block(wfirst - gap, thick * rng.uniform(0.92, 1.06),
                                       course - gap, rng.randrange(1 << 30)),
                  M(x=-length * 0.5 + wfirst * 0.5, z=z0 + course * 0.5,
                    yaw=rng.uniform(-1.2, 1.2)))
        while x < length * 0.5 - 0.12:
            w = min(rng.uniform(0.46, 0.96), length * 0.5 - x)
            cx = x + w * 0.5
            t = (cx + length * 0.5) / length
            topz = height * (1.0 - broken * (0.5 + 0.5 * prof(t)) * 0.85)
            if z0 + course * 0.5 < topz and rng.random() > 0.085:
                d = thick * rng.uniform(0.82, 1.16)
                bh = (course - gap) * rng.uniform(0.86, 1.0)
                # a few blocks sit proud or recessed: a perfectly flush face is
                # what makes procedural masonry read as brickwork
                r = rng.random()
                dy = rng.uniform(-0.05, 0.05)
                if r < 0.13:
                    dy -= rng.uniform(0.08, 0.16)
                elif r < 0.22:
                    dy += rng.uniform(0.05, 0.11)
                g.add("stone", stone_block(w - gap, d, bh,
                                           rng.randrange(1 << 30)),
                      M(x=cx, y=dy, z=z0 + bh * 0.5 + rng.uniform(0.0, 0.03),
                        yaw=rng.uniform(-4.5, 4.5), pitch=rng.uniform(-3.0, 3.0),
                        roll=rng.uniform(-2.2, 2.2)))
                key = int(round(cx / 0.34))
                if key not in tops or tops[key][0] < z0:
                    tops[key] = (z0, w, d, cx)
            x += w
    if snow > 0.0:
        for key, (z0, w, d, cx) in tops.items():
            if rng.random() > snow:
                continue
            bm = dome_bm(min(w, 0.42) * 0.55, d * 0.55,
                         0.05 + rng.uniform(0, 0.055),
                         rng.randrange(1 << 30), segs=8, rings=2, rough=0.35)
            g.add("snow", bm_part(bm, uvscale=0.7, smooth=True,
                                  uvoff=(rng.random(), rng.random())),
                  M(x=cx + rng.uniform(-0.06, 0.06), z=z0 + course - 0.015,
                    yaw=rng.uniform(0, 360)))
    return g


def mod_arch(span, pier_h, thick, seed, collapse=0.42, nvous=15):
    """Broken village gate: two piers, voussoir ring, one haunch fallen away."""
    g = Group()
    rng = random.Random(seed)
    hw = span * 0.5
    for side in (-1, 1):
        g.merge(mod_wall(1.15, pier_h, thick, seed + (5 if side < 0 else 9),
                         broken=0.0, snow=0.0),
                M(x=side * (hw + 0.575)))
        # buttress
        g.merge(mod_wall(0.7, pier_h * 0.55, thick * 1.5, seed + 31 + side,
                         broken=0.25, snow=0.9),
                M(x=side * (hw + 1.5), yaw=90))
    rad = hw + 0.28
    arcw = math.pi * rad / nvous
    for k in range(nvous):
        a = math.pi * (k + 0.5) / nvous
        if collapse > 0 and a > math.pi * (1.0 - collapse * 0.55) and rng.random() < 0.85:
            continue
        rj = rng.uniform(-0.02, 0.02)
        g.add("stone", stone_block(0.56, thick * rng.uniform(0.94, 1.06),
                                   arcw - 0.02, rng.randrange(1 << 30)),
              M(x=math.cos(a) * (rad + rj), z=math.sin(a) * (rad + rj) + pier_h,
                roll=-math.degrees(a), yaw=rng.uniform(-1.0, 1.0)))
    # keystone shelf of snow on the intact haunch
    for k in range(3):
        a = math.pi * (0.10 + 0.09 * k)
        bm = dome_bm(0.26, thick * 0.5, 0.06, seed + 200 + k, segs=8, rings=2)
        g.add("snow", bm_part(bm, uvscale=0.7, smooth=True),
              M(x=math.cos(a) * (rad + 0.26), z=math.sin(a) * (rad + 0.26) + pier_h))
    return g


def mod_rubble(radius, seed, mat="stone"):
    bm = rock_bm(radius, seed, subdiv=1 if radius < 0.28 else 2,
                 rough=0.46, squash=random.Random(seed).uniform(0.55, 0.85))
    rng = random.Random(seed + 3)
    return Group().add(mat, bm_part(bm, uvscale=0.55,
                                    uvoff=(rng.random(), rng.random())))


def mod_rubble_pile(radius, count, seed, snowy=0.5):
    g = Group()
    rng = random.Random(seed)
    for i in range(count):
        a = rng.uniform(0, TAU)
        d = radius * math.sqrt(rng.random())
        s = rng.uniform(0.10, 0.34) * (1.0 - 0.4 * d / max(0.01, radius))
        x, y = math.cos(a) * d, math.sin(a) * d
        g.merge(mod_rubble(s, rng.randrange(1 << 30)),
                M(x=x, y=y, z=s * rng.uniform(0.15, 0.55),
                  yaw=rng.uniform(0, 360), pitch=rng.uniform(-30, 30),
                  roll=rng.uniform(-30, 30)))
        if rng.random() < snowy:
            bm = dome_bm(s * 0.9, s * 0.8, s * 0.34, rng.randrange(1 << 30),
                         segs=8, rings=2, rough=0.4)
            g.add("snow", bm_part(bm, uvscale=0.8, smooth=True,
                                  uvoff=(rng.random(), rng.random())),
                  M(x=x, y=y, z=s * rng.uniform(0.45, 0.75), yaw=rng.uniform(0, 360)))
    return g


def mod_beam(length, w, h, seed, split=True, mat="timber"):
    """Squared timber with an axe-split, splintered end."""
    rng = random.Random(seed)
    bm = box(length, w, h, bev=0.016, seg=2)
    bm.verts.ensure_lookup_table()
    if split:
        for v in bm.verts:
            if v.co.x > length * 0.5 - 0.05:
                v.co.x += rng.uniform(-0.16, 0.10)
                v.co.z += rng.uniform(-0.03, 0.03)
                v.co.y += rng.uniform(-0.02, 0.02)
    jitter(bm, 0.006, rng)
    g = Group().add(mat, bm_part(bm, uvscale=0.42,
                                 uvoff=(rng.random(), rng.random())))
    return g


def mod_log(length, r, seed, segs=9, mat="timber", taper=0.88):
    rng = random.Random(seed)
    bm = cyl(r, length, segs=segs, bev=0.010, r2=r * taper)
    for v in bm.verts:
        v.co.x += noise.noise(v.co * 1.4) * r * 0.14
        v.co.y += noise.noise(v.co * 1.4 + Vector((9, 3, 1))) * r * 0.14
    bm.normal_update()
    return Group().add(mat, bm_part(bm, uvscale=0.5, smooth=False,
                                    uvrot=math.pi * 0.5,
                                    uvoff=(rng.random(), rng.random())))


def mod_palisade(length, height, seed, broken=0.5):
    """Row of upright split logs - the classic Nordic village wall."""
    g = Group()
    rng = random.Random(seed)
    prof = profile_fn(seed + 3)
    x = -length * 0.5
    while x < length * 0.5:
        r = rng.uniform(0.10, 0.16)
        t = (x + length * 0.5) / length
        h = height * (1.0 - broken * (0.5 + 0.5 * prof(t)) * 0.7) * rng.uniform(0.9, 1.05)
        h = max(0.5, h)
        g.merge(mod_log(h, r, rng.randrange(1 << 30), segs=8),
                M(x=x + r, y=rng.uniform(-0.05, 0.05), z=h * 0.5,
                  pitch=rng.uniform(-3, 3), roll=rng.uniform(-3, 3)))
        if rng.random() < 0.55:
            bm = dome_bm(r * 0.95, r * 0.95, r * 0.5, rng.randrange(1 << 30),
                         segs=7, rings=2)
            g.add("snow", bm_part(bm, uvscale=0.9, smooth=True),
                  M(x=x + r, z=h - 0.01))
        x += r * 2.0 + rng.uniform(0.005, 0.05)
    # two horizontal binding rails
    for k, zz in enumerate((height * 0.35, height * 0.72)):
        g.merge(mod_beam(length * 0.98, 0.09, 0.13, seed + 40 + k, split=False),
                M(y=-0.14, z=zz, roll=rng.uniform(-0.8, 0.8)))
    return g


def lathe(profile, segs, seed, close_bottom=True, close_top=True):
    """profile = [(radius, z), ...] bottom to top."""
    rng = random.Random(seed)
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        ring = []
        for s in range(segs):
            a = TAU * s / segs
            ring.append(bm.verts.new((math.cos(a) * r, math.sin(a) * r, z)))
        rings.append(ring)
    bm.verts.ensure_lookup_table()
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        for s in range(segs):
            s2 = (s + 1) % segs
            bm.faces.new((a[s], a[s2], b[s2], b[s]))
    if close_bottom and profile[0][0] > 1e-4:
        bm.faces.new(list(reversed(rings[0])))
    if close_top and profile[-1][0] > 1e-4:
        bm.faces.new(rings[-1])
    bm.normal_update()
    return bm


def mod_barrel(r, h, seed):
    g = Group()
    rng = random.Random(seed)
    prof = []
    for k in range(7):
        t = k / 6.0
        rr = r * (0.80 + 0.20 * math.sin(t * math.pi)) * rng.uniform(0.99, 1.01)
        prof.append((rr, -h * 0.5 + h * t))
    bm = lathe(prof, 14, seed)
    bevel(bm, 0.008, 1)
    g.add("plank", bm_part(bm, uvscale=0.9, uvrot=math.pi * 0.5,
                           uvoff=(rng.random(), rng.random())))
    for zz in (-h * 0.30, h * 0.30, 0.0):
        rr = r * (0.80 + 0.20 * math.sin((zz / h + 0.5) * math.pi)) * 1.035
        hoop = lathe([(rr, zz - 0.035), (rr, zz + 0.035)], 14, seed + 1,
                     close_bottom=False, close_top=False)
        g.add("iron", bm_part(hoop, uvscale=1.6, uvrot=math.pi * 0.5))
    return g


def mod_crate(s, seed):
    g = Group()
    rng = random.Random(seed)
    bm = box(s, s * rng.uniform(0.85, 1.0), s * rng.uniform(0.7, 1.0),
             bev=0.012, seg=2)
    g.add("plank", bm_part(bm, uvscale=1.0, uvoff=(rng.random(), rng.random())))
    for sx in (-1, 1):
        for sy in (-1, 1):
            g.add("plank", bm_part(box(0.05, 0.05, s * 0.96, bev=0.008)),
                  M(x=sx * s * 0.5, y=sy * s * 0.44))
    return g


def mod_plank_pile(n, seed):
    g = Group()
    rng = random.Random(seed)
    for k in range(n):
        L = rng.uniform(1.1, 2.2)
        g.merge(mod_beam(L, rng.uniform(0.16, 0.26), rng.uniform(0.035, 0.06),
                         rng.randrange(1 << 30), split=rng.random() < 0.4,
                         mat="plank"),
                M(x=rng.uniform(-0.2, 0.2), y=rng.uniform(-0.12, 0.12),
                  z=0.04 + k * 0.055, yaw=rng.uniform(-9, 9),
                  roll=rng.uniform(-2, 2)))
    return g


def mod_spear(length, seed):
    g = Group()
    rng = random.Random(seed)
    g.merge(mod_log(length, 0.024, seed, segs=7, taper=0.95),
            M(z=length * 0.5))
    head = box(0.055, 0.012, 0.30, bev=0.004, seg=1)
    head.verts.ensure_lookup_table()
    for v in head.verts:
        if v.co.z > 0.1:
            v.co.x *= 0.12
            v.co.y *= 0.5
    head.normal_update()
    g.add("iron", bm_part(head, uvscale=2.4, uvoff=(rng.random(), rng.random())),
          M(z=length + 0.13))
    g.add("iron", bm_part(cyl(0.032, 0.09, segs=8, bev=0.004)),
          M(z=length - 0.02))
    return g


def mod_shield(r, seed):
    g = Group()
    rng = random.Random(seed)
    face = lathe([(r, -0.03), (r * 0.99, 0.012), (r * 0.55, 0.045), (0.0, 0.06)],
                 16, seed)
    g.add("plank", bm_part(face, uvscale=0.9, uvoff=(rng.random(), rng.random())))
    rim = lathe([(r * 1.01, -0.035), (r * 1.045, 0.0), (r * 1.01, 0.03)], 16,
                seed + 1, close_bottom=False, close_top=False)
    g.add("iron", bm_part(rim, uvscale=2.0))
    boss = lathe([(0.085, 0.05), (0.075, 0.10), (0.03, 0.135), (0.0, 0.145)],
                 12, seed + 2)
    g.add("iron", bm_part(boss, uvscale=2.4, smooth=True))
    return g


def mod_banner(w, h, seed, tatter=0.35):
    """Hanging wool banner with sag, curl and a torn hem."""
    rng = random.Random(seed)
    nx, nz = 9, 13
    bm = bmesh.new()
    vs = []
    ph = rng.uniform(0, TAU)
    for j in range(nz + 1):
        tz = j / nz
        row = []
        hem = 1.0
        if tz > 0.86:
            hem = 1.0 - tatter * (tz - 0.86) / 0.14 * rng.uniform(0.4, 1.0)
        for i in range(nx + 1):
            tx = i / nx
            x = (tx - 0.5) * w
            z = -h * tz * hem
            y = (math.sin(tx * math.pi * 2.4 + ph) * 0.045
                 + math.sin(tz * math.pi * 1.6 + ph * 0.7) * 0.05 * tz)
            y += noise.noise(Vector((x, z, seed % 7))) * 0.02
            row.append(bm.verts.new((x, y, z)))
        vs.append(row)
    bm.verts.ensure_lookup_table()
    for j in range(nz):
        for i in range(nx):
            bm.faces.new((vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i]))
    bm.normal_update()
    g = Group().add("cloth", bm_part(bm, uvscale=0.75, smooth=True,
                                     uvoff=(rng.random(), rng.random())))
    g.merge(mod_log(w * 1.14, 0.035, seed + 5, segs=7),
            M(z=0.02, roll=90))
    return g


def mod_brazier(seed):
    g = Group()
    rng = random.Random(seed)
    bowl = lathe([(0.16, 0.0), (0.26, 0.10), (0.30, 0.22), (0.29, 0.24),
                  (0.24, 0.20)], 14, seed)
    g.add("iron", bm_part(bowl, uvscale=1.8, smooth=True))
    for k in range(3):
        a = TAU * k / 3 + 0.4
        g.add("iron", bm_part(cyl(0.026, 0.62, segs=6, bev=0.004)),
              M(x=math.cos(a) * 0.16, y=math.sin(a) * 0.16, z=-0.31,
                pitch=math.degrees(math.sin(a) * 0.16),
                roll=-math.degrees(math.cos(a) * 0.16)))
    for k in range(7):
        s = rng.uniform(0.035, 0.075)
        g.merge(mod_rubble(s, rng.randrange(1 << 30), mat="stone"),
                M(x=rng.uniform(-0.14, 0.14), y=rng.uniform(-0.14, 0.14),
                  z=0.15 + rng.uniform(0, 0.05)))
    return g


def mod_cartwheel(r, seed):
    g = Group()
    rng = random.Random(seed)
    pts = [Vector((math.cos(TAU * k / 18) * r, 0.0, math.sin(TAU * k / 18) * r))
           for k in range(19)]
    g.add("plank", bm_part(tube_path(pts, 0.055, segs=5), uvscale=1.2,
                           uvoff=(rng.random(), rng.random())))
    for k in range(8):
        a = TAU * k / 8
        g.add("plank", bm_part(box(0.045, 0.045, r * 0.92, bev=0.006)),
              M(z=0, roll=math.degrees(a), sz=1.0,
                x=math.cos(a + math.pi * 0.5) * 0, y=0))
    g.add("plank", bm_part(cyl(0.11, 0.17, segs=10, bev=0.01)),
          M(pitch=90))
    return g


def mod_rope_line(a, b, sag, seed, r=0.022):
    n = 9
    pts = []
    for k in range(n + 1):
        t = k / n
        p = a.lerp(b, t)
        p.z -= math.sin(t * math.pi) * sag
        p.x += noise.noise(Vector((t * 4, seed % 5, 1))) * 0.02
        pts.append(p)
    return Group().add("rope", bm_part(tube_path(pts, r, segs=5), uvscale=2.0))


def mod_deadtree(h, seed):
    g = Group()
    rng = random.Random(seed)
    trunk = []
    for k in range(9):
        t = k / 8.0
        trunk.append(Vector((math.sin(t * 2.1 + seed % 3) * 0.28 * t,
                             math.cos(t * 1.7) * 0.22 * t, t * h)))
    g.add("bark", bm_part(tube_path(trunk, 0.22, segs=8, taper=0.30),
                          uvscale=0.7, uvoff=(rng.random(), rng.random())))
    for k in range(rng.randint(5, 8)):
        t0 = rng.uniform(0.42, 0.95)
        base = Vector((math.sin(t0 * 2.1 + seed % 3) * 0.28 * t0,
                       math.cos(t0 * 1.7) * 0.22 * t0, t0 * h))
        a = rng.uniform(0, TAU)
        L = rng.uniform(0.9, 2.4) * (1.15 - t0)
        pts = [base]
        d = Vector((math.cos(a), math.sin(a), rng.uniform(0.25, 0.9))).normalized()
        for s in range(4):
            d = (d + Vector((rng.uniform(-.3, .3), rng.uniform(-.3, .3),
                             rng.uniform(-.25, .12)))).normalized()
            pts.append(pts[-1] + d * (L / 4.0))
        g.add("bark", bm_part(tube_path(pts, 0.075 * (1.1 - t0) * 2.2, segs=5,
                                        taper=0.18), uvscale=1.4))
    return g


def mod_snowdrift(rx, ry, h, seed):
    bm = dome_bm(rx, ry, h, seed, segs=18, rings=5, rough=0.42)
    rng = random.Random(seed)
    return Group().add("snow", bm_part(bm, uvscale=0.35, smooth=True,
                                       uvoff=(rng.random(), rng.random())))


def mod_mound(rx, ry, h, seed, mat="dirt", uvs=0.5):
    """Low churned patch - frozen mud on the trodden route, gravel spill."""
    bm = dome_bm(rx, ry, h, seed, segs=14, rings=4, rough=0.55)
    rng = random.Random(seed)
    return Group().add(mat, bm_part(bm, uvscale=uvs, smooth=True,
                                    uvoff=(rng.random(), rng.random())))


def mod_cliff(w, d, h, seed, mat="stone", chunks=5, subdiv=2, smooth=True):
    """Blocky strata mass. Used for the enclosing walls and the far skyline.

    Smooth-shaded on purpose: at 60 m+ a flat-shaded icosphere reads as a
    low-poly facet, while the normal map still carries the rock detail.
    """
    g = Group()
    rng = random.Random(seed)
    for k in range(chunks):
        s = rng.uniform(0.55, 1.0)
        bm = rock_bm(1.0, rng.randrange(1 << 30), subdiv=subdiv,
                     rough=rng.uniform(0.34, 0.52), squash=rng.uniform(0.5, 0.95))
        g.add(mat, bm_part(bm, uvscale=0.16, smooth=smooth,
                           uvoff=(rng.random(), rng.random())),
              M(x=rng.uniform(-0.35, 0.35) * w, y=rng.uniform(-0.35, 0.35) * d,
                z=rng.uniform(-0.25, 0.30) * h + h * 0.42,
                yaw=rng.uniform(0, 360),
                sx=w * 0.55 * s, sy=d * 0.55 * s, sz=h * 0.55 * s))
    return g


def mod_stairs(w, steps, rise, run, seed):
    g = Group()
    rng = random.Random(seed)
    for k in range(steps):
        g.add("stone", stone_block(w * rng.uniform(0.95, 1.0), run * 1.6,
                                   rise, rng.randrange(1 << 30), uvs=0.42),
              M(y=k * run, z=k * rise + rise * 0.5, yaw=rng.uniform(-1, 1)))
    return g


def mod_hall(w, d, wall_h, seed, door=True):
    """The great hall on the east side: stone plinth, timber frame, thatch roof.

    Local space: length along X, depth along Y, door in the -X face.
    """
    g = Group()
    rng = random.Random(seed)
    hw, hd = w * 0.5, d * 0.5
    plinth = 1.35
    # stone plinth on all four sides
    for (lx, ly, yaw, ln) in ((0, -hd, 0, w), (0, hd, 0, w),
                              (-hw, 0, 90, d), (hw, 0, 90, d)):
        g.merge(mod_wall(ln, plinth, 0.62, seed + int(lx * 7 + ly * 3) + 11,
                         broken=0.10, snow=0.25),
                M(x=lx, y=ly, yaw=yaw))
    # corner + intermediate posts
    npost = max(2, int(w / 1.45))
    for i in range(npost + 1):
        x = -hw + w * i / npost
        for y in (-hd, hd):
            g.merge(mod_beam(wall_h - plinth, 0.24, 0.28, rng.randrange(1 << 30),
                             split=False),
                    M(x=x, y=y, z=plinth + (wall_h - plinth) * 0.5, roll=90))
    npd = max(2, int(d / 1.6))
    for j in range(npd + 1):
        y = -hd + d * j / npd
        for x in (-hw, hw):
            if door and x < 0 and abs(y) < 1.25:
                continue
            g.merge(mod_beam(wall_h - plinth, 0.24, 0.26, rng.randrange(1 << 30),
                             split=False),
                    M(x=x, y=y, z=plinth + (wall_h - plinth) * 0.5, roll=90))
    # horizontal planking between the posts
    zz = plinth + 0.16
    while zz < wall_h - 0.12:
        th = rng.uniform(0.24, 0.38)
        for (lx, ly, yaw, ln) in ((0, -hd, 0, w), (0, hd, 0, w),
                                  (-hw, 0, 90, d), (hw, 0, 90, d)):
            if yaw == 90 and lx < 0 and door:
                # split around the doorway
                for (oy, sl) in ((-(d * 0.5 + 1.25) * 0.5, d * 0.5 - 1.25),
                                 ((d * 0.5 + 1.25) * 0.5, d * 0.5 - 1.25)):
                    if sl > 0.2 and zz < 3.05:
                        g.merge(mod_beam(sl, 0.16, th, rng.randrange(1 << 30),
                                         split=False),
                                M(x=lx - 0.03, y=oy, z=zz, yaw=yaw))
                    elif sl > 0.2:
                        g.merge(mod_beam(ln, 0.16, th, rng.randrange(1 << 30),
                                         split=False),
                                M(x=lx - 0.03, y=0, z=zz, yaw=yaw))
                        break
            else:
                g.merge(mod_beam(ln, 0.16, th, rng.randrange(1 << 30), split=False),
                        M(x=lx, y=ly, z=zz, yaw=yaw,
                          roll=rng.uniform(-0.4, 0.4)))
        zz += th + rng.uniform(0.015, 0.05)
    if door:
        # lintel + jambs + a dark recess so the interior reads as depth
        g.merge(mod_beam(2.9, 0.46, 0.34, seed + 77, split=False),
                M(x=-hw - 0.06, z=3.22, yaw=90))
        for sy in (-1, 1):
            g.merge(mod_beam(3.1, 0.30, 0.30, seed + 78 + sy, split=False),
                    M(x=-hw - 0.06, y=sy * 1.32, z=1.55, roll=90))
        g.add("timber", bm_part(box(1.8, 2.5, 3.0, bev=0.02)),
              M(x=-hw + 0.95, y=0, z=1.5 + 0.02))
    # gable roof
    rise = wall_h * 0.52
    slope = math.degrees(math.atan2(rise, hd))
    for sy in (-1, 1):
        L = math.hypot(hd + 0.55, rise)
        g.add("thatch", bm_part(box(w + 1.0, L, 0.30, bev=0.03),
                                uvscale=0.30, uvoff=(rng.random(), rng.random())),
              M(y=sy * (hd + 0.55) * 0.5, z=wall_h + rise * 0.5,
                pitch=-sy * slope))
        # eave purlin
        g.merge(mod_beam(w + 1.1, 0.16, 0.18, seed + 90 + sy, split=False),
                M(y=sy * (hd + 0.62), z=wall_h - 0.05))
    g.merge(mod_beam(w + 1.2, 0.26, 0.30, seed + 95, split=False),
            M(z=wall_h + rise + 0.10))
    for sy in (-1, 1):   # carved ridge finial
        g.merge(mod_beam(1.5, 0.14, 0.16, seed + 96 + sy, split=True),
                M(x=sy * (w * 0.5 + 0.5), z=wall_h + rise + 0.42,
                  roll=sy * 34, yaw=0))
    # gable ends
    for sx in (-1, 1):
        for k in range(6):
            t = k / 6.0
            g.merge(mod_beam(d * (1.0 - t) + 0.3, 0.14, 0.22,
                             rng.randrange(1 << 30), split=False),
                    M(x=sx * (hw + 0.02), z=wall_h + rise * t + 0.1, yaw=90))
    return g


def mod_longhouse_far(w, d, h, seed):
    """Cheap silhouette building for the 60m+ plane."""
    g = Group()
    rng = random.Random(seed)
    g.add("timber", bm_part(box(w, d, h, bev=0.05), uvscale=0.2,
                            uvoff=(rng.random(), rng.random())), M(z=h * 0.5))
    rise = h * 0.85
    slope = math.degrees(math.atan2(rise, d * 0.5 + 0.5))
    for sy in (-1, 1):
        L = math.hypot(d * 0.5 + 0.6, rise)
        g.add("thatch", bm_part(box(w + 1.2, L, 0.34, bev=0.05), uvscale=0.22,
                                uvoff=(rng.random(), rng.random())),
              M(y=sy * (d * 0.5 + 0.6) * 0.5, z=h + rise * 0.5, pitch=-sy * slope))
    g.merge(mod_beam(w + 1.4, 0.3, 0.34, seed + 3, split=False),
            M(z=h + rise + 0.1))
    return g


def mod_mast(h, seed):
    g = Group()
    rng = random.Random(seed)
    g.merge(mod_log(h, 0.17, seed, segs=8, taper=0.55), M(z=h * 0.5))
    yl = h * 0.42
    g.merge(mod_log(yl, 0.10, seed + 1, segs=7, taper=0.6),
            M(z=h * 0.78, roll=90))
    g.add("cloth", bm_part(box(yl * 0.92, 0.26, 0.34, bev=0.06), uvscale=0.6,
                           uvoff=(rng.random(), rng.random())),
          M(z=h * 0.78 - 0.24))
    for sx in (-1, 1):
        g.merge(mod_rope_line(Vector((sx * yl * 0.5, 0, h * 0.78)),
                              Vector((sx * h * 0.35, 0, 0.2)), 0.35, seed + sx))
    return g


# ================================================================ layout =====
def add_ground():
    """Inner detailed floor + outer landscape ring (the hole matches exactly)."""
    INNER, ICELL = 24.0, 0.40
    n = int(INNER * 2 / ICELL)
    bm = grid_bm(INNER * 2, INNER * 2, n, n, terrain_fine)
    W["ground"].stamp(bm_part(bm, uvscale=0.22, smooth=True), Matrix.Identity(4),
                      ground_col)

    OUTER, OCELL = 320.0, 4.0
    m = int(OUTER / OCELL)
    bmo = bmesh.new()
    rows = []
    for j in range(m + 1):
        row = []
        for i in range(m + 1):
            x = -OUTER * 0.5 + OCELL * i
            y = -OUTER * 0.5 + OCELL * j
            row.append(bmo.verts.new((x, y, terrain(x, y))))
        rows.append(row)
    bmo.verts.ensure_lookup_table()
    for j in range(m):
        for i in range(m):
            cx = -OUTER * 0.5 + OCELL * (i + 0.5)
            cy = -OUTER * 0.5 + OCELL * (j + 0.5)
            if abs(cx) < INNER and abs(cy) < INNER:
                continue
            bmo.faces.new((rows[j][i], rows[j][i + 1], rows[j + 1][i + 1],
                           rows[j + 1][i]))
    bmo.normal_update()
    W["ground"].stamp(bm_part(bmo, uvscale=0.22, smooth=True),
                      Matrix.Identity(4), ground_col)


def gz(x, y, off=0.0):
    return terrain_fine(x, y) + off


def layout():
    rng = R

    # ---------------------------------------------------- plane 4: far -----
    for k in range(26):
        a = rng.uniform(-2.5, 2.5)
        d = rng.uniform(62, 150)
        x, y = math.sin(a) * d, math.cos(a) * d
        if y < -40:
            continue
        h = rng.uniform(26, 68) * (0.7 + 0.5 * ss(60, 140, d))
        stamp(mod_cliff(rng.uniform(22, 50), rng.uniform(20, 42), h,
                        rng.randrange(1 << 30), chunks=4, subdiv=3),
              Mw=M(x=x, y=y, z=terrain(x, y) - h * 0.25, yaw=rng.uniform(0, 360)))
    for k in range(9):   # far ridge village
        x = rng.uniform(-52, 52)
        y = rng.uniform(58, 86)
        stamp(mod_longhouse_far(rng.uniform(9, 17), rng.uniform(6, 9),
                                rng.uniform(3.2, 4.6), rng.randrange(1 << 30)),
              Mw=M(x=x, y=y, z=terrain(x, y), yaw=rng.uniform(-30, 30)))
    for k in range(5):   # ship masts in the fjord
        x = rng.uniform(-26, 30)
        y = rng.uniform(48, 66)
        stamp(mod_mast(rng.uniform(9, 14), rng.randrange(1 << 30)),
              Mw=M(x=x, y=y, z=terrain(x, y) - 1.0, yaw=rng.uniform(0, 360),
                   pitch=rng.uniform(-5, 5)))
    for k in range(26):  # dead conifers on the far slopes
        a = rng.uniform(-2.2, 2.2)
        d = rng.uniform(40, 90)
        x, y = math.sin(a) * d, math.cos(a) * d
        stamp(mod_deadtree(rng.uniform(5, 11), rng.randrange(1 << 30)),
              Mw=M(x=x, y=y, z=terrain(x, y), yaw=rng.uniform(0, 360)))

    # -------------------------------------- enclosing cliffs (sides/back) --
    for k in range(30):
        side = 1 if k % 2 else -1
        x = side * rng.uniform(19, 34)
        y = rng.uniform(-26, 44)
        h = rng.uniform(9, 20)
        stamp(mod_cliff(rng.uniform(9, 18), rng.uniform(9, 17), h,
                        rng.randrange(1 << 30), chunks=4),
              Mw=M(x=x, y=y, z=terrain(x, y) - h * 0.22, yaw=rng.uniform(0, 360)))
    for k in range(10):
        x = rng.uniform(-24, 24)
        y = -rng.uniform(17, 30)
        h = rng.uniform(8, 17)
        stamp(mod_cliff(rng.uniform(10, 18), rng.uniform(9, 15), h,
                        rng.randrange(1 << 30), chunks=4),
              Mw=M(x=x, y=y, z=terrain(x, y) - h * 0.22, yaw=rng.uniform(0, 360)))

    # ------------------------------------------ plane 3: mid set dressing --
    # ruined village blocks beyond the gate
    for k in range(14):
        x = rng.uniform(-19, 19)
        y = rng.uniform(16, 38)
        if abs(x) < 3.0 and y < 22:
            continue
        stamp(mod_wall(rng.uniform(3.5, 8.0), rng.uniform(1.6, 4.4), 0.55,
                       rng.randrange(1 << 30), broken=rng.uniform(0.4, 0.8)),
              Mw=M(x=x, y=y, z=terrain(x, y), yaw=rng.uniform(0, 180)))
    for k in range(7):
        x = rng.uniform(-20, 20)
        y = rng.uniform(18, 36)
        stamp(mod_longhouse_far(rng.uniform(6, 11), rng.uniform(5, 7),
                                rng.uniform(2.6, 3.6), rng.randrange(1 << 30)),
              Mw=M(x=x, y=y, z=terrain(x, y), yaw=rng.uniform(-40, 40)))
    for k in range(6):
        x = rng.uniform(-17, 17)
        y = rng.uniform(15, 34)
        stamp(mod_palisade(rng.uniform(3, 7), rng.uniform(1.8, 3.0),
                           rng.randrange(1 << 30)),
              Mw=M(x=x, y=y, z=terrain(x, y), yaw=rng.uniform(0, 180)))
    for k in range(10):
        x = rng.uniform(-18, 18)
        y = rng.uniform(14, 34)
        stamp(mod_deadtree(rng.uniform(4, 8), rng.randrange(1 << 30)),
              Mw=M(x=x, y=y, z=terrain(x, y), yaw=rng.uniform(0, 360)))
    for k in range(16):
        x = rng.uniform(-20, 20)
        y = rng.uniform(13, 36)
        stamp(mod_rubble_pile(rng.uniform(0.7, 2.0), rng.randint(5, 12),
                              rng.randrange(1 << 30)),
              Mw=M(x=x, y=y, z=terrain(x, y)))

    # ------------------------------------------- the gate (north, focal) ---
    gate_y = 13.0
    stamp(mod_arch(3.6, 3.5, 0.85, 4001, collapse=0.5),
          Mw=M(x=0.2, y=gate_y, z=gz(0.2, gate_y) - 0.1))
    stamp(mod_wall(7.5, 4.3, 0.8, 4002, broken=0.62),
          Mw=M(x=-5.6, y=gate_y, z=gz(-5.6, gate_y) - 0.1))
    stamp(mod_wall(6.0, 3.6, 0.8, 4003, broken=0.75),
          Mw=M(x=5.9, y=gate_y, z=gz(5.9, gate_y) - 0.1))
    stamp(mod_wall(4.0, 2.6, 0.75, 4004, broken=0.85),
          Mw=M(x=-9.6, y=gate_y - 1.2, z=gz(-9.6, gate_y - 1.2) - 0.1, yaw=28))
    stamp(mod_stairs(4.2, 3, 0.20, 0.55, 4010),
          Mw=M(x=0.2, y=gate_y - 2.3, z=gz(0.2, gate_y - 2.3) - 0.30))
    stamp(mod_rubble_pile(2.2, 16, 4011), Mw=M(x=2.6, y=gate_y - 0.4,
                                               z=gz(2.6, gate_y - 0.4)))
    stamp(mod_rubble_pile(1.5, 10, 4012), Mw=M(x=-2.9, y=gate_y + 0.6,
                                               z=gz(-2.9, gate_y + 0.6)))

    # ------------------------------------------------- east: the great hall
    # The hall's door is in its -X face, so yaw stays 0 and the 11 m depth
    # becomes the west facade: a tall gable end facing the arena, as in the ref.
    hall_x, hall_y = 15.4, 1.0
    stamp(mod_hall(8.0, 11.0, 5.6, 5001, door=True),
          Mw=M(x=hall_x, y=hall_y, z=gz(hall_x, hall_y) - 0.05))
    stamp(mod_wall(7.0, 3.1, 0.7, 5010, broken=0.55),
          Mw=M(x=11.4, y=-6.6, z=gz(11.4, -6.6), yaw=6))
    stamp(mod_palisade(6.5, 2.9, 5011), Mw=M(x=11.9, y=8.8, z=gz(11.9, 8.8), yaw=-8))
    # lean-to scaffolding against the hall
    for k in range(5):
        y = -3.4 + k * 1.75
        stamp(mod_beam(4.4, 0.16, 0.20, 5100 + k),
              Mw=M(x=10.6, y=y, z=gz(10.6, y) + 2.2, roll=62, yaw=90))
    for k in range(3):
        stamp(mod_beam(7.0, 0.14, 0.18, 5120 + k),
              Mw=M(x=9.6 + k * 0.35, y=1.0, z=gz(9.6, 1.0) + 1.1 + k * 1.35, yaw=90))
    stamp(mod_banner(1.1, 2.6, 5200), Mw=M(x=10.35, y=-1.9,
                                           z=gz(10.35, -1.9) + 4.5, yaw=90))
    stamp(mod_banner(0.95, 2.2, 5201), Mw=M(x=10.35, y=3.4,
                                            z=gz(10.35, 3.4) + 4.3, yaw=90))
    stamp(mod_rope_line(Vector((10.4, -5.0, 4.6)), Vector((10.4, 5.4, 4.4)),
                        0.55, 5210))
    stamp(mod_rope_line(Vector((10.5, 2.0, 5.2)), Vector((4.6, 4.6, 2.1)),
                        0.35, 5211))

    # ----------------------------------------------- west: collapsed ruin --
    stamp(mod_wall(9.0, 3.9, 0.75, 6001, broken=0.66),
          Mw=M(x=-11.6, y=-1.0, z=gz(-11.6, -1.0) - 0.1, yaw=90))
    stamp(mod_wall(7.0, 2.9, 0.7, 6002, broken=0.8),
          Mw=M(x=-11.9, y=7.6, z=gz(-11.9, 7.6) - 0.1, yaw=78))
    stamp(mod_wall(6.5, 4.6, 0.8, 6003, broken=0.45),
          Mw=M(x=-12.4, y=-8.4, z=gz(-12.4, -8.4) - 0.1, yaw=104))
    stamp(mod_arch(2.6, 2.6, 0.7, 6004, collapse=0.7),
          Mw=M(x=-11.4, y=3.6, z=gz(-11.4, 3.6) - 0.1, yaw=90))
    stamp(mod_palisade(7.0, 3.2, 6005), Mw=M(x=-13.0, y=13.0,
                                             z=gz(-13.0, 13.0), yaw=52))
    stamp(mod_deadtree(6.4, 6100), Mw=M(x=-9.2, y=5.2, z=gz(-9.2, 5.2), yaw=40))
    stamp(mod_deadtree(4.6, 6101), Mw=M(x=-12.6, y=-4.2, z=gz(-12.6, -4.2), yaw=200))
    stamp(mod_rubble_pile(2.6, 20, 6110), Mw=M(x=-9.6, y=-1.4, z=gz(-9.6, -1.4)))
    stamp(mod_rubble_pile(1.8, 12, 6111), Mw=M(x=-8.4, y=8.2, z=gz(-8.4, 8.2)))
    stamp(mod_cartwheel(0.62, 6120), Mw=M(x=-7.6, y=-6.2, z=gz(-7.6, -6.2) + 0.22,
                                          yaw=24, pitch=76))
    stamp(mod_cartwheel(0.58, 6121), Mw=M(x=-8.9, y=-5.4, z=gz(-8.9, -5.4) + 0.05,
                                          yaw=-40, pitch=12))

    # ------------------------------------- south: behind-camera enclosure --
    stamp(mod_palisade(13.0, 3.6, 7001), Mw=M(x=-3.0, y=-12.6,
                                              z=gz(-3.0, -12.6), yaw=4))
    stamp(mod_wall(11.0, 4.2, 0.8, 7002, broken=0.5),
          Mw=M(x=7.5, y=-12.9, z=gz(7.5, -12.9) - 0.1, yaw=-6))
    stamp(mod_wall(8.0, 3.4, 0.75, 7003, broken=0.7),
          Mw=M(x=-11.5, y=-11.4, z=gz(-11.5, -11.4) - 0.1, yaw=62))

    # --------------------------------- plane 1: foreground occluder frame --
    # A collapsed roof truss rakes across the establishing shot's left edge and
    # a burnt post with a banner closes the right - the ref plates almost always
    # have something dark and near intruding from a frame edge (ART_BIBLE 2).
    # Aimed at the arena_estab camera (Godot -0.6, 1.86, 11.6): the truss only
    # rakes the top-left corner and the post clips the right edge, rather than
    # sitting across the middle of the frame.
    stamp(mod_beam(6.0, 0.28, 0.32, 8001),
          Mw=M(x=-2.5, y=-8.6, z=gz(-2.5, -8.6) + 2.90, yaw=8, roll=-20))
    stamp(mod_beam(3.8, 0.24, 0.26, 8002),
          Mw=M(x=-3.9, y=-8.9, z=gz(-3.9, -8.9) + 1.05, yaw=-40, roll=22))
    stamp(mod_beam(4.4, 0.22, 0.24, 8003),
          Mw=M(x=-4.9, y=-8.3, z=gz(-4.9, -8.3) + 0.45, yaw=64, roll=6))
    stamp(mod_log(4.8, 0.22, 8004), Mw=M(x=-2.0, y=-9.9, z=gz(-2.0, -9.9) + 2.30,
                                         roll=-13, pitch=4))
    stamp(mod_log(4.8, 0.24, 8010), Mw=M(x=1.2, y=-9.4, z=gz(1.2, -9.4) + 2.20,
                                         pitch=-12, roll=11))
    stamp(mod_banner(1.05, 2.4, 8011), Mw=M(x=1.52, y=-9.22,
                                            z=gz(1.2, -9.4) + 4.00, yaw=-16))
    stamp(mod_rope_line(Vector((1.2, -9.4, 4.3)), Vector((9.6, -7.1, 2.5)),
                        0.55, 8012))
    stamp(mod_rope_line(Vector((-4.0, -9.3, 3.6)), Vector((-10.4, -8.0, 2.2)),
                        0.45, 8013))
    stamp(mod_spear(2.05, 8020), Mw=M(x=0.4, y=-8.3, z=gz(0.4, -8.3) - 0.18,
                                      pitch=15, roll=-11))
    stamp(mod_spear(1.95, 8021), Mw=M(x=-2.6, y=-8.6, z=gz(-2.6, -8.6) - 0.15,
                                      pitch=-19, roll=8))
    stamp(mod_rubble_pile(1.7, 14, 8030), Mw=M(x=-3.0, y=-8.6, z=gz(-3.0, -8.6)))
    stamp(mod_rubble_pile(1.3, 10, 8031), Mw=M(x=1.6, y=-9.2, z=gz(1.6, -9.2)))
    stamp(mod_rubble_pile(1.5, 11, 8032), Mw=M(x=-0.6, y=-7.2, z=gz(-0.6, -7.2)))
    stamp(mod_plank_pile(5, 8033), Mw=M(x=-1.9, y=-6.4, z=gz(-1.9, -6.4), yaw=64))
    stamp(mod_crate(0.72, 8034), Mw=M(x=2.4, y=-7.4, z=gz(2.4, -7.4) + 0.30,
                                      yaw=-24))
    stamp(mod_barrel(0.34, 0.86, 8035), Mw=M(x=3.0, y=-6.6,
                                             z=gz(3.0, -6.6) + 0.41, yaw=12))

    # ------------------------------------ plane 2: the combat floor 4-9 m --
    stamp(mod_brazier(9001), Mw=M(x=-3.4, y=1.6, z=gz(-3.4, 1.6) + 0.62))
    stamp(mod_brazier(9002), Mw=M(x=4.9, y=6.4, z=gz(4.9, 6.4) + 0.62, yaw=40))
    stamp(mod_shield(0.44, 9010), Mw=M(x=2.15, y=-2.6, z=gz(2.15, -2.6) + 0.10,
                                       pitch=74, yaw=18))
    stamp(mod_shield(0.40, 9011), Mw=M(x=-5.2, y=3.1, z=gz(-5.2, 3.1) + 0.05,
                                       pitch=8, yaw=-50))
    stamp(mod_spear(2.1, 9020), Mw=M(x=-1.7, y=4.8, z=gz(-1.7, 4.8) - 0.2,
                                     pitch=13, roll=7))
    stamp(mod_spear(1.85, 9021), Mw=M(x=6.2, y=-1.2, z=gz(6.2, -1.2) - 0.16,
                                      pitch=-17, roll=-6))
    stamp(mod_spear(2.2, 9022), Mw=M(x=7.4, y=9.1, z=gz(7.4, 9.1) - 0.2,
                                     pitch=21, roll=10))

    barrels = [(-6.9, -3.2, 0), (-6.35, -3.9, 14), (-7.4, -4.4, -22),
               (8.2, 4.4, 5), (8.6, 5.3, 30), (7.9, 5.4, -12),
               (-2.2, 8.6, 8), (3.3, 10.2, -6), (9.1, -3.6, 18)]
    for i, (x, y, yaw) in enumerate(barrels):
        r_, h_ = 0.34, 0.86
        stamp(mod_barrel(r_, h_, 9100 + i),
              Mw=M(x=x, y=y, z=gz(x, y) + h_ * 0.5 - 0.02, yaw=yaw,
                   pitch=rng.uniform(-2, 2)))
    stamp(mod_barrel(0.33, 0.84, 9130), Mw=M(x=-7.0, y=-2.35,
                                             z=gz(-7.0, -2.35) + 0.33,
                                             pitch=90, yaw=28))
    for i, (x, y, s, yaw) in enumerate([(-5.6, -5.4, 0.76, 12), (-5.1, -6.1, 0.62, -20),
                                        (-5.9, -6.3, 0.55, 40), (9.0, 1.1, 0.80, -8),
                                        (8.7, 0.2, 0.60, 22), (2.9, 11.0, 0.7, 15),
                                        (-8.8, 10.6, 0.66, -30)]):
        stamp(mod_crate(s, 9200 + i), Mw=M(x=x, y=y, z=gz(x, y) + s * 0.42,
                                           yaw=yaw, pitch=rng.uniform(-3, 3)))
    stamp(mod_crate(0.7, 9220), Mw=M(x=-5.35, y=-5.7, z=gz(-5.35, -5.7) + 1.12,
                                     yaw=-8, roll=6))
    stamp(mod_plank_pile(6, 9300), Mw=M(x=6.6, y=-5.6, z=gz(6.6, -5.6), yaw=28))
    stamp(mod_plank_pile(5, 9301), Mw=M(x=-3.9, y=10.9, z=gz(-3.9, 10.9), yaw=-52))

    # loose beams strewn across the floor (diagonals - ART_BIBLE 2)
    beams = [(-2.4, -1.2, 34, 3.4), (4.2, 2.2, -28, 2.9), (1.1, 7.4, 61, 3.8),
             (-6.2, 1.0, 12, 2.6), (7.0, -7.4, -48, 3.1), (-1.0, -6.2, 74, 2.4),
             (5.6, 11.4, 22, 3.0), (-8.0, 3.4, -66, 2.2), (2.4, 4.6, 8, 2.0)]
    for i, (x, y, yaw, L) in enumerate(beams):
        stamp(mod_beam(L, rng.uniform(0.16, 0.30), rng.uniform(0.18, 0.30),
                       9400 + i),
              Mw=M(x=x, y=y, z=gz(x, y) + 0.11, yaw=yaw,
                   roll=rng.uniform(-6, 6), pitch=rng.uniform(-4, 4)))
    # a big broken beam propped against the west ruin: strong diagonal
    stamp(mod_beam(6.2, 0.34, 0.36, 9450),
          Mw=M(x=-8.4, y=-0.2, z=gz(-8.4, -0.2) + 1.55, yaw=-8, roll=27))
    stamp(mod_beam(5.0, 0.28, 0.30, 9451),
          Mw=M(x=6.9, y=9.6, z=gz(6.9, 9.6) + 1.25, yaw=40, roll=-24))

    # rubble + gravel scatter across the whole floor
    for i in range(46):
        x = rng.uniform(-10.5, 10.5)
        y = rng.uniform(-10.5, 12.0)
        if path_dist(x, y) < 0.9 and rng.random() < 0.55:
            continue
        stamp(mod_rubble_pile(rng.uniform(0.35, 1.25), rng.randint(3, 9),
                              rng.randrange(1 << 30), snowy=0.45),
              Mw=M(x=x, y=y, z=gz(x, y), yaw=rng.uniform(0, 360)))
    for i in range(120):
        x = rng.uniform(-11.5, 11.5)
        y = rng.uniform(-11.5, 13.0)
        s = rng.uniform(0.05, 0.19)
        stamp(mod_rubble(s, rng.randrange(1 << 30)),
              Mw=M(x=x, y=y, z=gz(x, y) + s * rng.uniform(0.1, 0.45),
                   yaw=rng.uniform(0, 360), pitch=rng.uniform(-40, 40),
                   roll=rng.uniform(-40, 40)))

    # snow drifts: wind-piled against every vertical, plus loose banks
    drifts = [(-10.2, -1.0, 3.6, 1.5, 0.5), (-10.6, 7.0, 2.8, 1.3, 0.42),
              (10.3, 1.0, 3.4, 1.6, 0.48), (10.6, -6.0, 2.6, 1.2, 0.36),
              (-2.0, 12.3, 4.0, 1.5, 0.45), (5.2, 12.2, 3.2, 1.3, 0.40),
              (-6.0, -10.6, 3.4, 1.4, 0.42), (6.5, -11.2, 3.0, 1.2, 0.38),
              (-7.6, -6.6, 1.5, 1.1, 0.22), (8.2, 6.0, 1.6, 1.0, 0.20),
              (0.6, -3.4, 2.2, 1.4, 0.16), (-3.6, 6.8, 1.9, 1.2, 0.14),
              (4.0, 8.6, 1.7, 1.1, 0.15), (-8.9, 2.6, 1.4, 1.0, 0.18)]
    for i, (x, y, rx, ry, h) in enumerate(drifts):
        stamp(mod_snowdrift(rx, ry, h, 9600 + i),
              Mw=M(x=x, y=y, z=gz(x, y) - 0.04, yaw=rng.uniform(0, 360)))
    for i in range(30):
        x = rng.uniform(-12, 12)
        y = rng.uniform(-12, 14)
        stamp(mod_snowdrift(rng.uniform(0.5, 1.5), rng.uniform(0.4, 1.1),
                            rng.uniform(0.05, 0.16), 9700 + i),
              Mw=M(x=x, y=y, z=gz(x, y) - 0.03, yaw=rng.uniform(0, 360)))

    # churned frozen mud where the route is walked bare, plus gravel spill
    for i in range(18):
        for _ in range(24):
            x = rng.uniform(-11, 11)
            y = rng.uniform(-11, 13)
            if path_dist(x, y) < 1.5:
                break
        stamp(mod_mound(rng.uniform(0.5, 1.3), rng.uniform(0.4, 0.9),
                        rng.uniform(0.03, 0.06), 9800 + i),
              Mw=M(x=x, y=y, z=gz(x, y) - 0.015, yaw=rng.uniform(0, 360)))
    for i in range(10):
        x = rng.uniform(-10, 10)
        y = rng.uniform(-10, 12)
        stamp(mod_mound(rng.uniform(0.5, 1.2), rng.uniform(0.4, 0.9),
                        rng.uniform(0.09, 0.22), 9850 + i, uvs=0.8),
              Mw=M(x=x, y=y, z=gz(x, y) - 0.02, yaw=rng.uniform(0, 360)))


# ================================================================== main =====
def main():
    wipe_scene()
    print("building ground...")
    add_ground()
    print("building layout...")
    layout()

    objs = []
    for m in MATS:
        acc = W[m]
        if not acc.faces:
            print(f"  (skip {m}: empty)")
            continue
        print(f"  {m:8s} {len(acc.verts):8d} verts  {acc.tris():8d} tris")
        objs.append(build_object(acc))

    for ob in objs:
        path = os.path.join(OUT, ob.name + ".glb")
        export_glb([ob], path)
        print(f"  -> {path}")
    print("done")


if __name__ == "__main__":
    main()
