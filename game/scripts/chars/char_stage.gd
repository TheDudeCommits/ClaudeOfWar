extends Node3D
## Character showcase stage.
##
## Prefers the real level: if another agent has landed `res://scenes/world/world.tscn`
## we instance it and light the characters with the shipping environment, which is
## the only way the skin/leather/metal response can be judged honestly. If the
## world is not there yet (or fails to instance) we fall back to a self-contained
## key/fill/rim rig plus a WorldEnvironment carrying the ART_BIBLE §4 post chain,
## so this piece is never blocked on somebody else's directory.

const WORLD_PATH := "res://scenes/world/world.tscn"

@onready var _hero: Node3D = $Hero
@onready var _zombie: Node3D = $Zombie

var _cam: Camera3D = null
var _focus_target: Node3D = null
var _spec: Dictionary = {}
var _local_lights: Node3D = null


var _char_lights: Node3D = null


func _ready() -> void:
	_spec = _read_own_shot_spec()
	var has_world := _try_instance_world()
	if not has_world:
		_build_local_stage()
	# world.tscn ships its own Sun/Rim/Fill and a grade chain, so with it
	# present this rig is a modelling assist only, not a second key light.
	_build_character_lights(0.45 if has_world else 1.0)
	_focus_target = _resolve_focus_target()
	print("[char_stage] hero %.3f m, zombie %.3f m" %
		[_hero.call("measured_height"), _zombie.call("measured_height")])
	set_process(true)


func _build_character_lights(scale: float) -> void:
	## Runs whether or not the world loaded. The world's lighting is authored for
	## a level; a character still needs its own key and rim, and without them the
	## figure reads flat and unseparated (ART_BIBLE §3, §12.10).
	var rig := Node3D.new()
	rig.name = "CharacterLights"
	rig.set_script(preload("res://scripts/chars/char_lights.gd"))
	add_child(rig)
	_char_lights = rig
	rig.call("add_subject", _hero.global_position, 1.55, scale)
	rig.call("add_subject", _zombie.global_position, 1.60, scale * 0.9)
	var tod := str(_spec.get("time_of_day", "cold_overcast"))
	rig.call("set_recipe", tod)


# ------------------------------------------------------------------- lighting

func _try_instance_world() -> bool:
	if not ResourceLoader.exists(WORLD_PATH):
		return false
	var ps := ResourceLoader.load(WORLD_PATH, "PackedScene", ResourceLoader.CACHE_MODE_REUSE)
	if ps == null or not (ps is PackedScene):
		push_warning("world.tscn exists but did not load; using local stage lighting")
		return false
	var inst := (ps as PackedScene).instantiate()
	if inst == null:
		return false
	inst.name = "World"
	add_child(inst)
	move_child(inst, 0)
	# The world ships its own camera for its own shots; ours must win.
	for c in inst.find_children("*", "Camera3D", true, false):
		(c as Camera3D).current = false
	print("[char_stage] lit by ", WORLD_PATH)
	return true


func _build_local_stage() -> void:
	print("[char_stage] world.tscn absent — local 3-point rig")
	var root := Node3D.new()
	root.name = "LocalLights"
	root.set_script(preload("res://scripts/chars/local_stage_lights.gd"))
	add_child(root)
	_local_lights = root


# --------------------------------------------------------------------- camera

func _resolve_focus_target() -> Node3D:
	var want := str(_spec.get("focus_on", ""))
	if want != "":
		var n := find_child(want, true, false)
		if n is Node3D:
			return n as Node3D
	return _hero


func _process(_dt: float) -> void:
	# The capture rig assigns the camera AFTER the scene is ready, so focus has
	# to be re-derived every frame during warmup rather than once in _ready.
	var cam := get_viewport().get_camera_3d()
	if cam == null:
		return
	if cam != _cam:
		_cam = cam
		_setup_camera_attributes(cam)
	_autofocus(cam)


func _setup_camera_attributes(cam: Camera3D) -> void:
	var dof: Dictionary = _spec.get("dof", {})
	if bool(dof.get("enabled", true)) == false:
		return
	var a := CameraAttributesPractical.new()
	a.dof_blur_far_enabled = true
	a.dof_blur_near_enabled = true
	a.dof_blur_amount = float(dof.get("amount", 0.12))
	# Exposure stays with the environment / world grade chain. Setting camera
	# attributes at all overrides it, so auto-exposure is explicitly off here and
	# these attributes carry depth of field and nothing else.
	a.auto_exposure_enabled = false
	# Expose for the subject. Camera attributes override the environment's
	# exposure, which is authored for the level as a whole and currently clips
	# skin and white hair; a shot spec is allowed to stop down for its subject.
	a.exposure_multiplier = float(_spec.get("exposure", 1.0))
	cam.attributes = a


func _autofocus(cam: Camera3D) -> void:
	if cam.attributes == null or _focus_target == null:
		return
	var a := cam.attributes as CameraAttributesPractical
	if a == null:
		return
	var dof: Dictionary = _spec.get("dof", {})
	# Focus on the head, not the origin: a portrait focused at the feet is the
	# classic tell that nobody looked at the shot.
	var head_h := float(dof.get("focus_height", 1.55))
	var p := _focus_target.global_position + Vector3.UP * head_h
	var d := cam.global_position.distance_to(p)
	var near_frac := float(dof.get("near_frac", 0.55))
	var far_frac := float(dof.get("far_frac", 1.35))
	a.dof_blur_far_distance = d * far_frac
	a.dof_blur_far_transition = maxf(0.15, d * 0.35)
	a.dof_blur_near_distance = d * near_frac
	a.dof_blur_near_transition = maxf(0.15, d * 0.30)


# ---------------------------------------------------------------------- spec

func _read_own_shot_spec() -> Dictionary:
	## The harness only forwards `camera` / `pose` / `time_of_day` to us. Reading
	## the same JSON ourselves lets a shot carry DOF intent without changing the
	## harness contract that every other agent depends on.
	var shot := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--shot="):
			shot = a.substr(7)
	if shot == "":
		return {}
	var p := "res://shots/%s.json" % shot
	if not FileAccess.file_exists(p):
		return {}
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(p))
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}
