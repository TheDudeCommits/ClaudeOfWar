@tool
extends Node3D
## Base for every ClaudeOfWar character.
##
## Owns three things:
##   1. a rig-agnostic bone resolver (Meshy / Mixamo / Blender naming all work),
##   2. `freeze_at_pose(clip, t)` — the contract the capture harness calls,
##   3. runtime material rebuild, because glTF-imported materials are always
##      wrong for our purposes (no SSS, no masked metallic, constant roughness).
##
## Poses are authored as SKELETON-SPACE euler offsets from the rest pose, so a
## pose written once works regardless of how the source rig oriented its bone
## axes. See `_apply_bone_rotation`.

## Canonical bone slots. Values are candidate names, normalized (lowercase,
## punctuation stripped), tried in order: exact match first, then substring.
const BONE_ALIASES: Dictionary = {
	"hips":      ["hips", "pelvis", "hip", "root"],
	"spine":     ["spine", "spine0", "spine01", "abdomen"],
	"chest":     ["spine1", "spine02", "chest", "spine2"],
	"upperchest":["spine2", "spine03", "upperchest"],
	"neck":      ["neck", "neck1"],
	"head":      ["head"],

	"shoulderl": ["leftshoulder", "shoulderl", "clavicle_l", "clavicle l", "lclavicle", "lshoulder"],
	"arml":      ["leftarm", "upperarml", "upperarm_l", "larm", "arm_l", "upper_arm_l"],
	"forearml":  ["leftforearm", "lowerarml", "forearm_l", "lforearm", "lower_arm_l"],
	"handl":     ["lefthand", "handl", "hand_l", "lhand"],

	"shoulderr": ["rightshoulder", "shoulderr", "clavicle_r", "clavicle r", "rclavicle", "rshoulder"],
	"armr":      ["rightarm", "upperarmr", "upperarm_r", "rarm", "arm_r", "upper_arm_r"],
	"forearmr":  ["rightforearm", "lowerarmr", "forearm_r", "rforearm", "lower_arm_r"],
	"handr":     ["righthand", "handr", "hand_r", "rhand"],

	"uplegl":    ["leftupleg", "thighl", "upperlegl", "thigh_l", "lthigh", "upleg_l"],
	"legl":      ["leftleg", "shinl", "calfl", "lowerlegl", "shin_l", "lshin"],
	"footl":     ["leftfoot", "footl", "foot_l", "lfoot"],

	"uplegr":    ["rightupleg", "thighr", "upperlegr", "thigh_r", "rthigh", "upleg_r"],
	"legr":      ["rightleg", "shinr", "calfr", "lowerlegr", "shin_r", "rshin"],
	"footr":     ["rightfoot", "footr", "foot_r", "rfoot"],
}

var skeleton: Skeleton3D = null
var _bone_idx: Dictionary = {}          # slot -> int
var _resolved := false
var _current_clip := ""
var _current_t := 0.0

## Extra yaw applied to every pose, in degrees, so a character whose GLB faces
## +Z still poses correctly. Set per-character.
@export var pose_space_yaw_deg: float = 0.0


func _ready() -> void:
	_resolve_rig()
	if not Engine.is_editor_hint():
		_rebuild_materials()
		freeze_at_pose(default_clip(), 0.0)


# ---------------------------------------------------------------- rig plumbing

func _resolve_rig() -> void:
	if _resolved:
		return
	_resolved = true
	skeleton = _first_skeleton(self)
	if skeleton == null:
		push_warning("%s: no Skeleton3D found under character root" % name)
		return
	# glTF ships an AnimationPlayer even when there is nothing to play; let it
	# never fight a frozen pose.
	for ap in find_children("*", "AnimationPlayer", true, false):
		(ap as AnimationPlayer).active = false

	var normalized: Dictionary = {}
	for i in skeleton.get_bone_count():
		normalized[_normalize(skeleton.get_bone_name(i))] = i

	# Explicit pins win. Meshy's rig, for one, names the *lowest* spine joint
	# "Spine02" and the *highest* one "Spine", so alias matching alone would
	# invert the whole torso chain and bend the character at the sternum.
	var pinned := bone_overrides()
	for slot: String in pinned.keys():
		var n := _normalize(str(pinned[slot]))
		if normalized.has(n):
			_bone_idx[slot] = int(normalized[n])
		else:
			push_warning("%s: bone override '%s' -> '%s' not found" % [name, slot, pinned[slot]])

	for slot: String in BONE_ALIASES.keys():
		if _bone_idx.has(slot):
			continue
		var idx := -1
		var candidates: Array = BONE_ALIASES[slot]
		for c: String in candidates:                       # exact pass
			var n := _normalize(c)
			if normalized.has(n):
				idx = int(normalized[n])
				break
		if idx < 0:                                        # substring pass
			for c: String in candidates:
				var n := _normalize(c)
				for k: String in normalized.keys():
					if k.contains(n):
						idx = int(normalized[k])
						break
				if idx >= 0:
					break
		if idx >= 0:
			_bone_idx[slot] = idx


static func _normalize(s: String) -> String:
	var out := s.to_lower()
	for junk in ["mixamorig", ":", "_", ".", " ", "-"]:
		out = out.replace(junk, "")
	return out


static func _first_skeleton(n: Node) -> Skeleton3D:
	if n is Skeleton3D:
		return n as Skeleton3D
	for c in n.get_children():
		var s := _first_skeleton(c)
		if s != null:
			return s
	return null


## Subclasses pin exact bone names here when a rig's naming would mislead the
## alias table. Slot -> bone name as it appears in the skeleton.
func bone_overrides() -> Dictionary:
	return {}


func has_bone(slot: String) -> bool:
	return _bone_idx.has(slot)


# ---------------------------------------------------------------------- poses

## Override in subclasses. Returns { clip_name: [ {"t": float, "pose": {...}}, ... ] }
## where a pose maps a bone slot to a Vector3 of skeleton-space euler degrees.
func pose_library() -> Dictionary:
	return {"idle": [{"t": 0.0, "pose": {}}]}


func default_clip() -> String:
	return "idle"


## THE HARNESS CONTRACT. Hold `clip` at normalized time `t` and stop moving.
func freeze_at_pose(clip: String, t: float) -> void:
	_resolve_rig()
	_current_clip = clip
	_current_t = t
	if skeleton == null:
		return

	var lib := pose_library()
	var key := clip
	if not lib.has(key):
		key = default_clip()
	if not lib.has(key):
		_reset_to_rest()
		return

	var frames: Array = lib[key]
	var pose := _sample(frames, t)

	_reset_to_rest()
	for slot: String in pose.keys():
		if not _bone_idx.has(slot):
			continue
		_apply_bone_rotation(int(_bone_idx[slot]), pose[slot])

	# Root offsets let a pose shift weight / crouch without a Hips translation
	# fight; applied after rotations so the hierarchy is already settled.
	skeleton.force_update_bone_child_transform(0)

	# Freeze: nothing in this subtree may advance time after a capture pose.
	set_process(false)
	set_physics_process(false)


func _sample(frames: Array, t: float) -> Dictionary:
	if frames.is_empty():
		return {}
	if frames.size() == 1:
		return (frames[0] as Dictionary).get("pose", {})
	var tc := clampf(t, float((frames[0] as Dictionary).get("t", 0.0)),
					 float((frames[frames.size() - 1] as Dictionary).get("t", 1.0)))
	for i in range(frames.size() - 1):
		var a: Dictionary = frames[i]
		var b: Dictionary = frames[i + 1]
		var ta := float(a.get("t", 0.0))
		var tb := float(b.get("t", 1.0))
		if tc <= tb or i == frames.size() - 2:
			var u := 0.0 if is_equal_approx(ta, tb) else clampf((tc - ta) / (tb - ta), 0.0, 1.0)
			u = u * u * (3.0 - 2.0 * u)             # smoothstep: no linear robot pops
			return _blend(a.get("pose", {}), b.get("pose", {}), u)
	return (frames[frames.size() - 1] as Dictionary).get("pose", {})


static func _blend(a: Dictionary, b: Dictionary, u: float) -> Dictionary:
	var out: Dictionary = {}
	var keys: Dictionary = {}
	for k: String in a.keys():
		keys[k] = true
	for k: String in b.keys():
		keys[k] = true
	for k: String in keys.keys():
		var va: Vector3 = a.get(k, Vector3.ZERO)
		var vb: Vector3 = b.get(k, Vector3.ZERO)
		out[k] = va.lerp(vb, u)
	return out


func _reset_to_rest() -> void:
	for i in skeleton.get_bone_count():
		skeleton.set_bone_pose_rotation(i, skeleton.get_bone_rest(i).basis.get_rotation_quaternion())
		skeleton.set_bone_pose_position(i, skeleton.get_bone_rest(i).origin)


## Rotate a bone by `euler_deg` measured in SKELETON space, not bone-local space.
##
## Bone-local axes differ wildly between exporters (Meshy points bones down +Y,
## Blender down +Y but with a different roll, Mixamo something else again), so a
## pose authored in bone-local euler is unportable. Converting the rotation into
## the bone's parent frame makes "rotate the upper arm 40 degrees about world X"
## mean the same thing on every rig we might swap in.
func _apply_bone_rotation(idx: int, euler_deg: Vector3) -> void:
	var e := euler_deg
	var r := Basis.from_euler(Vector3(deg_to_rad(e.x), deg_to_rad(e.y), deg_to_rad(e.z)))
	if not is_zero_approx(pose_space_yaw_deg):
		var y := Basis(Vector3.UP, deg_to_rad(pose_space_yaw_deg))
		r = y * r * y.inverse()

	var parent := skeleton.get_bone_parent(idx)
	var parent_basis := Basis.IDENTITY
	if parent >= 0:
		parent_basis = skeleton.get_bone_global_rest(parent).basis.orthonormalized()

	var local := parent_basis.inverse() * r * parent_basis
	var rest := skeleton.get_bone_rest(idx).basis.get_rotation_quaternion()
	skeleton.set_bone_pose_rotation(idx, (local.get_rotation_quaternion() * rest).normalized())


# ------------------------------------------------------------------ materials

## Subclasses override to swap in hand-authored StandardMaterial3D per surface.
## glTF import gives us a single unlit-ish material with constant roughness and
## no subsurface — an automatic fail against ART_BIBLE §7/§12.
func _rebuild_materials() -> void:
	pass


## World-space height of the character's visible geometry, in metres. Printed at
## boot so "hero ~1.8 m" is a measurement in the capture log rather than a claim.
func measured_height() -> float:
	var lo := INF
	var hi := -INF
	for mi in mesh_instances():
		if mi.mesh == null:
			continue
		# A skinned mesh's vertices live in skin space and are placed by the
		# skeleton, not by the MeshInstance3D's own transform — using the latter
		# reported this 1.8 m character as 0.018 m.
		var aabb := mi.global_transform * mi.mesh.get_aabb()
		lo = minf(lo, aabb.position.y)
		hi = maxf(hi, aabb.position.y + aabb.size.y)
	if skeleton != null and has_bone("head"):
		# Skinned vertices are placed by the bone matrices, so the MeshInstance3D
		# transform is not the rendered scale (it reported this 1.8 m character as
		# 0.018 m). Measure the rig instead: floor to the top of the head bone,
		# plus the skull above that joint.
		var head := skeleton.global_transform * skeleton.get_bone_global_pose(
			int(_bone_idx["head"])).origin
		var feet := global_position.y
		if has_bone("footl"):
			feet = (skeleton.global_transform * skeleton.get_bone_global_pose(
				int(_bone_idx["footl"])).origin).y
		return (head.y - feet) / 0.855      # head joint sits at ~85.5% of stature
	return 0.0 if lo == INF else hi - lo


func mesh_instances() -> Array[MeshInstance3D]:
	var out: Array[MeshInstance3D] = []
	for m in find_children("*", "MeshInstance3D", true, false):
		out.append(m as MeshInstance3D)
	return out


## Assign `mat` to every surface whose glTF material name matches `name_hint`
## (case-insensitive substring). Returns how many surfaces were hit.
func apply_material(name_hint: String, mat: Material) -> int:
	var hits := 0
	for mi in mesh_instances():
		var mesh := mi.mesh
		if mesh == null:
			continue
		for s in mesh.get_surface_count():
			var src := mesh.surface_get_material(s)
			var sname := "" if src == null else src.resource_name
			if name_hint == "*" or sname.to_lower().contains(name_hint.to_lower()):
				mi.set_surface_override_material(s, mat)
				hits += 1
	return hits


func surface_names() -> PackedStringArray:
	var out := PackedStringArray()
	for mi in mesh_instances():
		if mi.mesh == null:
			continue
		for s in mi.mesh.get_surface_count():
			var src := mi.mesh.surface_get_material(s)
			out.append("" if src == null else src.resource_name)
	return out
