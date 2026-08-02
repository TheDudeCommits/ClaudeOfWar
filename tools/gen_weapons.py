#!/usr/bin/env python3
"""Procedural weapon meshes -> GLB, for the fighter roster.

Run headless:
    blender --background --python tools/gen_weapons.py

Weapons are built from primitives with real bevels. Sharp 90-degree edges are
one of the clearest "untextured prototype" tells (ART_BIBLE §12): a bevel only
0.4mm wide still catches a specular line and is most of what separates a prop
that reads as forged metal from one that reads as a box.

Each weapon is authored with its grip at the origin, +Y along the shaft, so it
can be parented straight to a `RightHand` bone without a fixup transform.
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'web', 'public', 'assets', 'weapons')


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, base, metallic, rough, emis=None, emis_str=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*base, 1)
    b.inputs['Metallic'].default_value = metallic
    b.inputs['Roughness'].default_value = rough
    if emis:
        b.inputs['Emission Color'].default_value = (*emis, 1)
        b.inputs['Emission Strength'].default_value = emis_str
    return m


def bevel(obj, width=0.0035, segments=3, angle=40):
    md = obj.modifiers.new('bev', 'BEVEL')
    md.width = width
    md.segments = segments
    md.limit_method = 'ANGLE'
    md.angle_limit = math.radians(angle)
    md.harden_normals = True
    obj.data.use_auto_smooth = True if hasattr(obj.data, 'use_auto_smooth') else None
    return obj


def add_box(name, size, loc, rot=(0, 0, 0), material=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = Vector(size) * 0.5
    bpy.ops.object.transform_apply(scale=True)
    if material:
        o.data.materials.append(material)
    return o


def add_cyl(name, r, h, loc, rot=(0, 0, 0), verts=20, material=None):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, vertices=verts,
                                        location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    if material:
        o.data.materials.append(material)
    return o


def join(objs, name):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    return o


def export(name):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in bpy.data.objects:
        o.select_set(True)
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, name + '.glb'),
        export_format='GLB', use_selection=True,
        export_apply=True, export_yup=True)
    print('  wrote', name + '.glb')


# ---------------------------------------------------------------- weapons

def leviathan_axe():
    """Bearded Norse axe. Heavy head, short haft, runic inlay."""
    reset()
    steel = mat('steel', (0.62, 0.64, 0.67), 1.0, 0.30)
    dark = mat('dark_iron', (0.16, 0.16, 0.18), 1.0, 0.52)
    wood = mat('haft', (0.20, 0.13, 0.08), 0.0, 0.72)
    rune = mat('rune', (0.72, 0.55, 0.20), 1.0, 0.28, (1.0, 0.62, 0.18), 3.5)

    parts = []
    parts.append(add_cyl('haft', 0.021, 0.72, (0, 0.36, 0), verts=14, material=wood))
    parts.append(add_cyl('collar', 0.030, 0.05, (0, 0.70, 0), verts=14, material=dark))
    parts.append(add_cyl('pommel', 0.030, 0.045, (0, 0.02, 0), verts=14, material=dark))

    # Head: a tapered blade plus the beard that hooks back toward the haft.
    blade = add_box('blade', (0.055, 0.20, 0.15), (0.0, 0.775, 0.03), material=steel)
    bm = bmesh.new(); bm.from_mesh(blade.data)
    for v in bm.verts:
        if v.co.z > 0:                       # taper toward the cutting edge
            v.co.x *= 0.16
            v.co.y *= 1.28
    bm.to_mesh(blade.data); bm.free()
    parts.append(blade)

    beard = add_box('beard', (0.048, 0.10, 0.075), (0, 0.705, 0.055), material=steel)
    bm = bmesh.new(); bm.from_mesh(beard.data)
    for v in bm.verts:
        if v.co.z > 0: v.co.x *= 0.2
        if v.co.y < 0: v.co.z *= 0.35
    bm.to_mesh(beard.data); bm.free()
    parts.append(beard)

    parts.append(add_box('inlay', (0.058, 0.012, 0.10), (0, 0.80, 0.012), material=rune))
    for p in parts:
        bevel(p, 0.0035, 3)
    o = join(parts, 'leviathan_axe')
    export('axe')


def twin_blades():
    """Paired short blades for a fast fighter."""
    reset()
    steel = mat('steel', (0.70, 0.71, 0.74), 1.0, 0.22)
    wrap = mat('wrap', (0.24, 0.06, 0.07), 0.0, 0.80)
    parts = []
    parts.append(add_cyl('grip', 0.017, 0.16, (0, 0.08, 0), verts=12, material=wrap))
    parts.append(add_box('guard', (0.10, 0.022, 0.030), (0, 0.17, 0), material=steel))
    blade = add_box('blade', (0.038, 0.62, 0.010), (0, 0.49, 0), material=steel)
    bm = bmesh.new(); bm.from_mesh(blade.data)
    for v in bm.verts:
        if v.co.y > 0: v.co.x *= 0.10            # point
        v.co.z *= 1.0 - abs(v.co.x) * 6.0        # lenticular cross-section
    bm.to_mesh(blade.data); bm.free()
    parts.append(blade)
    for p in parts:
        bevel(p, 0.0022, 2)
    join(parts, 'twin_blade')
    export('blade')


def war_spear():
    """Long reach weapon: leaf-shaped head, banded shaft."""
    reset()
    steel = mat('steel', (0.66, 0.67, 0.70), 1.0, 0.28)
    dark = mat('dark_iron', (0.15, 0.15, 0.17), 1.0, 0.55)
    wood = mat('shaft', (0.23, 0.16, 0.10), 0.0, 0.70)
    parts = [add_cyl('shaft', 0.017, 1.55, (0, 0.775, 0), verts=12, material=wood)]
    for y in (0.35, 0.85, 1.30):
        parts.append(add_cyl('band', 0.021, 0.03, (0, y, 0), verts=12, material=dark))
    head = add_box('head', (0.070, 0.26, 0.016), (0, 1.66, 0), material=steel)
    bm = bmesh.new(); bm.from_mesh(head.data)
    for v in bm.verts:
        if v.co.y > 0: v.co.x *= 0.08
        else: v.co.x *= 0.45
        v.co.z *= 1.0 - abs(v.co.x) * 4.0
    bm.to_mesh(head.data); bm.free()
    parts.append(head)
    parts.append(add_cyl('ferrule', 0.020, 0.07, (0, 0.03, 0), verts=12, material=dark))
    for p in parts:
        bevel(p, 0.0025, 2)
    join(parts, 'war_spear')
    export('spear')


def great_hammer():
    """Slow, heavy: a banded iron head on a long haft."""
    reset()
    dark = mat('dark_iron', (0.19, 0.19, 0.21), 1.0, 0.46)
    steel = mat('steel', (0.58, 0.60, 0.63), 1.0, 0.34)
    wood = mat('haft', (0.18, 0.12, 0.07), 0.0, 0.74)
    parts = [add_cyl('haft', 0.024, 0.95, (0, 0.475, 0), verts=14, material=wood)]
    parts.append(add_box('head', (0.15, 0.18, 0.15), (0, 1.00, 0), material=dark))
    for z in (-0.076, 0.076):
        parts.append(add_box('face', (0.155, 0.10, 0.018), (0, 1.00, z), material=steel))
    parts.append(add_cyl('collar', 0.034, 0.06, (0, 0.90, 0), verts=14, material=steel))
    for p in parts:
        bevel(p, 0.004, 3)
    join(parts, 'great_hammer')
    export('hammer')


if __name__ == '__main__':
    print('generating weapons ->', OUT)
    leviathan_axe()
    twin_blades()
    war_spear()
    great_hammer()
    print('done')
