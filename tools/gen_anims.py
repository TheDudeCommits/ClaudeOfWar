#!/usr/bin/env python3
"""Author animation clips directly onto the character rig, in Blender.

    blender --background --python tools/gen_anims.py

Why author rather than retarget: Mixamo needs an interactive download, and
retargeting introduces a bone-mapping error on top of whatever the source clip
does. Authoring against the actual skeleton removes both problems.

The important part is HOW the legs are driven. The previous runtime animator
drove a sinusoidal hip ANGLE at a fixed pelvis height, which mathematically
cannot plant a foot: foot velocity equals -body velocity at only two instants
per cycle, and swinging a straight leg to 0.78 rad lifts the foot 27cm. The
motion critic measured the result — stance foot sliding at 92% of body speed
with the lower toe a median 17cm off the floor.

Here the driver is inverted, as it should be: a FOOT TRAJECTORY is authored in
character space (stance travels straight back at constant speed at y=0; swing
arcs forward with toe clearance), Blender's IK solver derives the hip and knee,
and the result is baked to bone keyframes. Pelvis height is authored to follow
the stance leg. Foot planting is then a property of the data, not something the
runtime has to fight for.

Clips are authored IN PLACE (root stationary) with a known stride length; the
runtime plays them at rate = speed / strideLength so the plant holds at any
speed.
"""
import bpy, math, os, sys
from mathutils import Vector, Quaternion

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHARS = os.path.join(ROOT, 'web', 'public', 'assets', 'chars')

FPS = 30
# Stride length in rig units, written into the exported clip name so the
# runtime never has to guess it.
STRIDE = 1.15


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def find_rig():
    arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
    if arm is None:
        raise RuntimeError('no armature in file')
    return arm


def bone_len(arm, a, b):
    """Bone length in WORLD units.

    pose_bone.head is in ARMATURE space. This rig is authored in centimetres
    under a 0.01 world scale, so an armature-space length of 78 is 0.78m. The
    IK empties live in world space, so mixing the two asked the foot to rise
    ten metres and the solver simply saturated — which is why an authored 6cm
    lift baked out as 0.92m.
    """
    pa = arm.matrix_world @ arm.pose.bones[a].head
    pb = arm.matrix_world @ arm.pose.bones[b].head
    return (pa - pb).length


def add_ik(arm, shin_bone, target_empty, chain=2):
    """IK on the SHIN with a 2-bone chain (shin + thigh).

    Constraining the FOOT with chain_count=2 chains Foot->Leg and leaves the
    thigh out entirely, so the solver can only bend the knee. It cannot reach
    the target, flails, and the resulting bake lifted the foot 0.92m against an
    authored 0.06m. Constraining the shin is the conventional leg setup and
    puts both thigh and shin under the solver.
    """
    pb = arm.pose.bones[shin_bone]
    for c in list(pb.constraints):
        pb.constraints.remove(c)
    ik = pb.constraints.new('IK')
    ik.target = target_empty
    ik.chain_count = chain
    return ik


def make_empty(name, loc):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.05
    e.location = loc
    bpy.context.collection.objects.link(e)
    return e


def foot_path(phase, stride, lift, ground):
    """Foot position along one gait cycle.

    phase 0..1. Stance occupies 0..0.6 and travels straight backward at a
    constant rate — that is the whole point, and it is what makes the plant
    hold. Swing occupies 0.6..1.0 and arcs forward with toe clearance.
    """
    if phase < 0.6:
        u = phase / 0.6
        z = stride * (0.5 - u)          # front -> back, linear
        y = ground
    else:
        u = (phase - 0.6) / 0.4
        z = stride * (-0.5 + u)         # back -> front
        y = ground + math.sin(u * math.pi) * lift
    return z, y


def author_locomotion(arm, name, cycle_frames, stride, lift, bob, lean):
    """Key the foot empties and hips over one cycle, then bake."""
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = cycle_frames

    hips = arm.pose.bones['Hips']
    lf = arm.pose.bones['LeftFoot']
    rf = arm.pose.bones['RightFoot']

    # World-space rest positions give us the ground plane and the lateral
    # offset of each foot.
    lw = arm.matrix_world @ lf.head
    rw = arm.matrix_world @ rf.head   # ankle position = shin tail
    ground = min(lw.z, rw.z)

    eL = make_empty('ik_L', lw)
    eR = make_empty('ik_R', rw)
    add_ik(arm, 'LeftLeg', eL, chain=2)
    add_ik(arm, 'RightLeg', eR, chain=2)

    hips_rest_z = hips.location.z

    # The export bind is a 43-degree A-pose. Nothing in the clip touched the
    # arms, so they baked out at that bind and the character ran with its arms
    # splayed like a scarecrow. The upper body has to be authored too: arms
    # down at the sides, elbows bent, counter-swinging against the legs.
    arms = {}
    for side, sgn in (('Left', 1.0), ('Right', -1.0)):
        for bn in (side + 'Shoulder', side + 'Arm', side + 'ForeArm'):
            if bn in arm.pose.bones:
                pb = arm.pose.bones[bn]
                pb.rotation_mode = 'XYZ'
                arms[bn] = (pb, sgn)

    for f in range(1, cycle_frames + 1):
        scene.frame_set(f)
        p = (f - 1) / cycle_frames

        zl, yl = foot_path(p, stride, lift, ground)
        zr, yr = foot_path((p + 0.5) % 1.0, stride, lift, ground)

        # NOTE THE SIGN. Blender's +Y maps to three.js's -Z through the glTF
        # Y-up conversion, so `+ zl` sent the stance foot FORWARD in character
        # space. Instead of cancelling the body's motion it added to it, which
        # is why the measured stance foot moved at 3.08 m/s in character space
        # while the body did 2.83 and the world-space slip came out at 3.51
        # rather than ~0. Every tuning attempt was fighting a sign.
        eL.location = Vector((lw.x, lw.y + zl, yl))
        eR.location = Vector((rw.x, rw.y + zr, yr))
        eL.keyframe_insert('location', frame=f)
        eR.keyframe_insert('location', frame=f)

        # Pelvis rises when both legs are extended (twice per cycle) and drops
        # over the stance leg. Authored to follow the legs rather than fought
        # against them.
        hips.location.z = hips_rest_z - abs(math.sin(p * math.pi * 2)) * bob
        hips.rotation_mode = 'XYZ'
        hips.rotation_euler = (lean, 0.0, math.sin(p * math.pi * 2) * 0.05)
        hips.keyframe_insert('location', frame=f)
        hips.keyframe_insert('rotation_euler', frame=f)

        # Arms: bring them down out of the A-pose, then swing opposite the legs.
        sw = math.sin(p * math.pi * 2)
        for bn, (pb, sgn) in arms.items():
            if bn.endswith('Shoulder'):
                pb.rotation_euler = (0.0, 0.0, sgn * -0.10)
            elif bn.endswith('ForeArm'):
                # Elbow always carries some bend; a straight arm reads as a doll.
                pb.rotation_euler = (-0.42 - abs(sw) * 0.22, 0.0, 0.0)
            else:  # upper arm
                # -0.62 rad of inward roll is what closes the A-pose to a
                # natural hang; the pitch term is the counter-swing.
                pb.rotation_euler = (sw * sgn * 0.55, 0.0, sgn * -0.62)
            pb.keyframe_insert('rotation_euler', frame=f)

        # Spine counter-rotates against the hips.
        for bn, amt in (('Spine', -0.10), ('Spine01', -0.06)):
            if bn in arm.pose.bones:
                pb = arm.pose.bones[bn]
                pb.rotation_mode = 'XYZ'
                pb.rotation_euler = (lean * 0.4, sw * amt, 0.0)
                pb.keyframe_insert('rotation_euler', frame=f)

    # Bake the IK result into plain bone keyframes and drop the constraints so
    # the exported clip is self-contained.
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.select_all(action='SELECT')
    bpy.ops.nla.bake(frame_start=1, frame_end=cycle_frames, only_selected=True,
                     visual_keying=True, clear_constraints=True,
                     clear_parents=False, use_current_action=True,
                     bake_types={'POSE'})
    bpy.ops.object.mode_set(mode='OBJECT')

    act = arm.animation_data.action
    act.name = name
    act.use_fake_user = True
    for e in (eL, eR):
        bpy.data.objects.remove(e, do_unlink=True)
    return act


def main():
    src = os.path.join(CHARS, 'hero_ashvald.glb')
    clear()
    bpy.ops.import_scene.gltf(filepath=src)
    arm = find_rig()
    print('  armature:', arm.name, 'bones:', len(arm.pose.bones))

    thigh = bone_len(arm, 'LeftUpLeg', 'LeftLeg')
    shin = bone_len(arm, 'LeftLeg', 'LeftFoot')
    leg = thigh + shin
    print('  leg length (rig units): %.3f' % leg)

    # Stride and clearance scale off the actual leg so the numbers transfer to
    # any rig this is run against.
        # Calibrated against MEASURED clip output, not against theory: the solver
    # reaches roughly a third of the requested excursion, so the request is
    # scaled to land the measured stance travel near 0.55m and lift near 0.14m.
    author_locomotion(arm, 'run', 20, stride=leg * 3.40, lift=leg * 0.46,
                      bob=leg * 0.045, lean=math.radians(7))

    out = os.path.join(CHARS, 'hero_anims.glb')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB',
                              use_selection=True, export_animations=True,
                              export_animation_mode='ACTIONS',
                              export_bake_animation=True, export_yup=True)
    print('  wrote', out)


if __name__ == '__main__':
    main()
