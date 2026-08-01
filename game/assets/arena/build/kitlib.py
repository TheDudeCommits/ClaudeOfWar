"""bmesh primitives + a per-material geometry accumulator for the arena kit.

Authoring space is Blender's, with a deliberate convention:
    +X = east,  +Y = NORTH,  +Z = up
glTF export (Y-up) maps that to Godot as:  gx = X, gy = Z, gz = -Y.
So Godot's -Z (forward/north) is Blender's +Y, which keeps the layout readable.

Everything is box-projected in *local* space before it is stamped into the
world, so wood grain follows each beam's own long axis instead of the world's.
"""
import math
import random

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector, noise

TAU = math.pi * 2.0


# ------------------------------------------------------------------ parts ---
class Part:
    """Flat geometry payload: verts, polygon index lists, per-loop UVs."""
    __slots__ = ("verts", "faces", "uvs", "smooth")

    def __init__(self, verts, faces, uvs, smooth):
        self.verts = verts
        self.faces = faces
        self.uvs = uvs
        self.smooth = smooth


class Group:
    """A module: a bag of (material, Part, local matrix) triples."""

    def __init__(self):
        self.items = []

    def add(self, mat, part, M=None):
        self.items.append((mat, part, M if M is not None else Matrix.Identity(4)))
        return self

    def merge(self, other, M=None):
        M = M if M is not None else Matrix.Identity(4)
        for mat, part, Mi in other.items:
            self.items.append((mat, part, M @ Mi))
        return self


class Acc:
    """Accumulates every stamp for one material into a single mesh."""

    def __init__(self, name):
        self.name = name
        self.verts = []
        self.faces = []
        self.uvs = []
        self.cols = []
        self.smooth = []

    def stamp(self, part, M, colfn, tint=1.0):
        base = len(self.verts)
        wverts = [M @ v for v in part.verts]
        self.verts.extend(wverts)
        li = 0
        for fi, f in enumerate(part.faces):
            self.faces.append([i + base for i in f])
            self.smooth.append(part.smooth[fi])
            for i in f:
                self.uvs.append(part.uvs[li])
                self.cols.append(colfn(wverts[i], tint))
                li += 1

    def tris(self):
        return sum(max(0, len(f) - 2) for f in self.faces)


# ------------------------------------------------------------- conversion ---
def bm_part(bm, uvscale=0.5, smooth=False, uvrot=0.0, uvoff=(0.0, 0.0)):
    """Box-project a bmesh in local space and freeze it into a Part."""
    bm.normal_update()
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()   # hand-built bmeshes carry stale (-1) indices
    verts = [v.co.copy() for v in bm.verts]
    faces, uvs, sm = [], [], []
    ca, sa = math.cos(uvrot), math.sin(uvrot)
    for f in bm.faces:
        faces.append([v.index for v in f.verts])
        sm.append(smooth)
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for v in f.verts:
            c = v.co
            if ax == 0:
                u, w = c.y, c.z
            elif ax == 1:
                u, w = c.x, c.z
            else:
                u, w = c.x, c.y
            u, w = u * ca - w * sa, u * sa + w * ca
            uvs.append((u * uvscale + uvoff[0], w * uvscale + uvoff[1]))
    bm.free()
    return Part(verts, faces, uvs, sm)


# ------------------------------------------------------------- primitives ---
def _cone(bm, segments, r1, r2, depth, cap=True):
    try:
        bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segments,
                              radius1=r1, radius2=r2, depth=depth)
    except TypeError:
        bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segments,
                              diameter1=r1 * 2.0, diameter2=r2 * 2.0, depth=depth)
    return bm


def _ico(bm, subdiv, radius):
    try:
        bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=radius)
    except TypeError:
        bmesh.ops.create_icosphere(bm, subdivisions=subdiv, diameter=radius * 2.0)
    return bm


def bevel(bm, offset, segments=2, profile=0.62):
    if offset <= 0.0:
        return bm
    geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
    bmesh.ops.bevel(bm, geom=geom, offset=offset, segments=segments,
                    profile=profile, affect='EDGES', clamp_overlap=True)
    return bm


def jitter(bm, amount, rng, freq=0.0):
    """Random per-vertex nudge; `freq` > 0 makes it coherent instead of noisy."""
    if amount <= 0.0:
        return bm
    for v in bm.verts:
        if freq > 0.0:
            n = Vector((noise.noise(v.co * freq + Vector((11.3, 5.1, 2.7))),
                        noise.noise(v.co * freq + Vector((3.9, 17.2, 8.4))),
                        noise.noise(v.co * freq + Vector((7.1, 2.2, 23.5)))))
            v.co += n * amount
        else:
            v.co += Vector((rng.uniform(-1, 1), rng.uniform(-1, 1),
                            rng.uniform(-1, 1))) * amount
    return bm


def box(sx, sy, sz, bev=0.03, seg=2, jit=0.0, rng=None, subd=0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((sx, sy, sz)), verts=bm.verts)
    if subd:
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=subd,
                                  use_grid_fill=True)
    if jit and rng:
        jitter(bm, jit, rng)
    bevel(bm, bev, seg)
    return bm


def cyl(r, h, segs=12, bev=0.012, cap=True, r2=None):
    bm = bmesh.new()
    _cone(bm, segs, r, r if r2 is None else r2, h, cap)
    if bev > 0:
        bevel(bm, bev, 1)
    return bm


def rock_bm(r, seed, subdiv=2, rough=0.42, squash=0.72):
    """Angular displaced boulder - the workhorse for rubble and cliffs."""
    rng = random.Random(seed)
    bm = bmesh.new()
    _ico(bm, subdiv, r)
    o = Vector((rng.uniform(-40, 40), rng.uniform(-40, 40), rng.uniform(-40, 40)))
    for v in bm.verts:
        p = v.co / max(1e-4, r)
        d = (noise.noise(p * 1.7 + o) * 0.60
             + noise.noise(p * 4.1 + o * 1.7) * 0.28
             + noise.noise(p * 9.3 + o * 2.9) * 0.12)
        v.co *= (1.0 + d * rough)
        v.co.z *= squash
        v.co.x *= 1.0 + rng.uniform(-0.12, 0.12)
        v.co.y *= 1.0 + rng.uniform(-0.12, 0.12)
    bevel(bm, r * 0.035, 1)
    return bm


def grid_bm(sx, sy, nx, ny, hfn):
    """Height-field grid. hfn(x, y) -> z."""
    bm = bmesh.new()
    vs = []
    for j in range(ny + 1):
        row = []
        for i in range(nx + 1):
            x = -sx * 0.5 + sx * i / nx
            y = -sy * 0.5 + sy * j / ny
            row.append(bm.verts.new((x, y, hfn(x, y))))
        vs.append(row)
    bm.verts.ensure_lookup_table()
    for j in range(ny):
        for i in range(nx):
            bm.faces.new((vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i]))
    bm.normal_update()
    return bm


def dome_bm(rx, ry, h, seed, segs=16, rings=5, rough=0.30):
    """Flattened noisy dome - snow drifts, dirt mounds, gravel heaps."""
    rng = random.Random(seed)
    o = Vector((rng.uniform(-30, 30), rng.uniform(-30, 30), 0.0))
    bm = bmesh.new()
    centre = bm.verts.new((0, 0, h))
    rings_v = []
    for k in range(1, rings + 1):
        t = k / rings
        ring = []
        for s in range(segs):
            a = TAU * s / segs
            wob = 1.0 + noise.noise(Vector((math.cos(a), math.sin(a), 0)) * 2.2 + o) * rough
            x = math.cos(a) * rx * t * wob
            y = math.sin(a) * ry * t * wob
            z = h * math.cos(t * math.pi * 0.5) ** 1.35
            z += noise.noise(Vector((x, y, 0)) * 1.5 + o) * h * 0.22 * (1.0 - t)
            ring.append(bm.verts.new((x, y, max(0.0, z))))
        rings_v.append(ring)
    bm.verts.ensure_lookup_table()
    for s in range(segs):
        bm.faces.new((centre, rings_v[0][s], rings_v[0][(s + 1) % segs]))
    for k in range(rings - 1):
        a, b = rings_v[k], rings_v[k + 1]
        for s in range(segs):
            s2 = (s + 1) % segs
            bm.faces.new((a[s], b[s], b[s2], a[s2]))
    bm.normal_update()
    return bm


def tube_path(points, radius, segs=6, taper=1.0):
    """Sweep a polygon along a polyline - ropes, branches, chains."""
    bm = bmesh.new()
    rings = []
    n = len(points)
    for k, p in enumerate(points):
        if k == 0:
            d = (points[1] - points[0])
        elif k == n - 1:
            d = (points[-1] - points[-2])
        else:
            d = (points[k + 1] - points[k - 1])
        d.normalize()
        up = Vector((0, 0, 1))
        if abs(d.dot(up)) > 0.97:
            up = Vector((1, 0, 0))
        sx = d.cross(up).normalized()
        sy = d.cross(sx).normalized()
        r = radius * (1.0 - (1.0 - taper) * (k / max(1, n - 1)))
        ring = []
        for s in range(segs):
            a = TAU * s / segs
            ring.append(bm.verts.new(p + sx * (math.cos(a) * r) + sy * (math.sin(a) * r)))
        rings.append(ring)
    bm.verts.ensure_lookup_table()
    for k in range(n - 1):
        a, b = rings[k], rings[k + 1]
        for s in range(segs):
            s2 = (s + 1) % segs
            bm.faces.new((a[s], a[s2], b[s2], b[s]))
    bm.normal_update()
    return bm


# --------------------------------------------------------------- transform ---
def M(x=0.0, y=0.0, z=0.0, yaw=0.0, pitch=0.0, roll=0.0, s=1.0,
      sx=None, sy=None, sz=None):
    """Placement matrix. yaw is about +Z (the compass), degrees throughout."""
    T = Matrix.Translation(Vector((x, y, z)))
    R = Euler((math.radians(pitch), math.radians(roll), math.radians(yaw)),
              'XYZ').to_matrix().to_4x4()
    S = Matrix.Diagonal(Vector((sx if sx else s, sy if sy else s,
                                sz if sz else s, 1.0)))
    return T @ R @ S


# ------------------------------------------------------------------ export ---
def build_object(acc, colour_name="Col"):
    me = bpy.data.meshes.new(acc.name)
    me.from_pydata([tuple(v) for v in acc.verts], [], acc.faces)
    me.update()
    if len(me.polygons) != len(acc.faces):
        print(f"  !! {acc.name}: {len(acc.faces)} faces in, "
              f"{len(me.polygons)} out (degenerate geometry dropped)")
    uvl = me.uv_layers.new(name="UVMap")
    uv2 = me.uv_layers.new(name="UVMap2")
    n = min(len(uvl.data), len(acc.uvs))
    for i in range(n):
        u, v = acc.uvs[i]
        uvl.data[i].uv = (u, v)
        uv2.data[i].uv = (u * 7.0, v * 7.0)
    col = me.color_attributes.new(name=colour_name, type='FLOAT_COLOR',
                                  domain='CORNER')
    m = min(len(col.data), len(acc.cols))
    for i in range(m):
        c = acc.cols[i]
        col.data[i].color = (c[0], c[1], c[2], 1.0)
    for i, p in enumerate(me.polygons):
        if i < len(acc.smooth):
            p.use_smooth = bool(acc.smooth[i])
    me.update()
    ob = bpy.data.objects.new(acc.name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def export_glb(objects, path):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    want = dict(filepath=path, export_format='GLB', use_selection=True,
                export_yup=True, export_apply=False, export_normals=True,
                export_tangents=True, export_texcoords=True,
                export_materials='NONE', export_cameras=False,
                export_lights=False, export_extras=False,
                export_skins=False, export_animations=False,
                export_all_vertex_colors=True, export_attributes=True)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = {k: v for k, v in want.items() if k in props}
    bpy.ops.export_scene.gltf(**kw)
    return path


def wipe_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for blk in (bpy.data.meshes, bpy.data.objects, bpy.data.materials):
        for it in list(blk):
            if it.users == 0:
                blk.remove(it)
