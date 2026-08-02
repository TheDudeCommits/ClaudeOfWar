#!/usr/bin/env python3
"""Bake ambient-occlusion maps for the character meshes.

    blender --background --python tools/bake_char_maps.py

The round-28 critic measured our draugr torso at luma p5 0.329 against the
reference Kratos torso's 0.059 and named the cause: not one of the four
character materials carries an `aoMap`, while all eleven `arena_*` materials
carry a full ORM set. Screen-space AO cannot fill that in — N8AO at any radius
resolves object-vs-object contact, not the self-occlusion inside an armpit, a
neck, a fist or a cloth fold. That has to be baked from the mesh.

The GLBs are Draco-compressed; Blender's importer handles that transparently.
"""
import bpy, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHARS = os.path.join(ROOT, 'web', 'public', 'assets', 'chars')
SIZE = 1024


def bake_ao(glb_name, out_name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = os.path.join(CHARS, glb_name)
    bpy.ops.import_scene.gltf(filepath=path)

    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    if not meshes:
        print('  no mesh in', glb_name)
        return
    print('  %s: %d mesh(es)' % (glb_name, len(meshes)))

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True

    img = bpy.data.images.new(out_name, SIZE, SIZE, alpha=False)

    for o in meshes:
        # A pose/armature modifier would bake the posed shape; we want bind pose.
        for m in list(o.modifiers):
            if m.type == 'ARMATURE':
                o.modifiers.remove(m)
        if not o.data.materials:
            o.data.materials.append(bpy.data.materials.new('tmp'))
        for slot in o.material_slots:
            mat = slot.material
            if mat is None:
                continue
            mat.use_nodes = True
            node = mat.node_tree.nodes.new('ShaderNodeTexImage')
            node.image = img
            node.select = True
            mat.node_tree.nodes.active = node

    for o in bpy.data.objects:
        o.select_set(o.type == 'MESH')
    bpy.context.view_layer.objects.active = meshes[0]

    scene.render.bake.use_selected_to_active = False
    scene.render.bake.margin = 8
    try:
        bpy.ops.object.bake(type='AO')
    except Exception as e:
        print('  bake failed:', e)
        return

    out = os.path.join(CHARS, out_name + '.png')
    img.filepath_raw = out
    img.file_format = 'PNG'
    img.save()
    print('  wrote', out_name + '.png')


if __name__ == '__main__':
    bake_ao('hero_ashvald.glb', 'hero_ashvald_ao')
    bake_ao('zombie_draugr.glb', 'zombie_draugr_ao')
    print('done')
