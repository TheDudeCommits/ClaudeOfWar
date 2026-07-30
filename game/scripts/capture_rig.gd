extends Node
## Capture harness. Boots a shot spec, waits for the renderer to converge,
## writes a PNG, quits. Shared by every critic agent — do not change its
## contract (--shot / --out / exit code) without updating docs/HARNESS.md.

const DEFAULT_WARMUP := 90

var _shot_name := ""
var _out_path := ""
var _spec: Dictionary = {}


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--shot="): _shot_name = a.substr(7)
		elif a.begins_with("--out="): _out_path = a.substr(6)
	if _shot_name == "":
		return  # normal play session; stay out of the way
	set_process(false)
	_run.call_deferred()


func _run() -> void:
	var spec_path := "res://shots/%s.json" % _shot_name
	if not FileAccess.file_exists(spec_path):
		push_error("no shot spec: " + spec_path)
		print("CAPTURE FAIL missing-spec ", spec_path)
		get_tree().quit(2)
		return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(spec_path))
	if typeof(parsed) != TYPE_DICTIONARY:
		print("CAPTURE FAIL bad-json ", spec_path)
		get_tree().quit(2)
		return
	_spec = parsed

	var res: Array = _spec.get("resolution", [1920, 1080])
	var vp_size := Vector2i(int(res[0]), int(res[1]))
	DisplayServer.window_set_size(vp_size)
	get_tree().root.content_scale_size = vp_size

	var scene_path: String = _spec.get("scene", "")
	if scene_path != "" and FileAccess.file_exists(scene_path):
		get_tree().change_scene_to_file(scene_path)
		await get_tree().process_frame
		await get_tree().process_frame

	var root := get_tree().current_scene
	if root == null:
		print("CAPTURE FAIL no-scene")
		get_tree().quit(2)
		return

	_apply_time_of_day(root)
	_apply_pose(root)
	_apply_camera(root)

	# Renderer convergence: SDFGI, volumetric fog, TAA history and auto-exposure
	# all need real frames. Capturing early produces a dark, noisy, unfair shot.
	var warm: int = int(_spec.get("warmup_frames", DEFAULT_WARMUP))
	for i in warm:
		await RenderingServer.frame_post_draw

	var img := get_viewport().get_texture().get_image()
	if _out_path == "":
		_out_path = "user://%s.png" % _shot_name
	DirAccess.make_dir_recursive_absolute(_out_path.get_base_dir())
	var err := img.save_png(_out_path)
	print("CAPTURE ", "OK" if err == OK else "FAIL", " ", _out_path, " ",
		img.get_width(), "x", img.get_height())
	get_tree().quit(0 if err == OK else 1)


func _apply_camera(root: Node) -> void:
	var cam: Camera3D = null
	for n in root.find_children("*", "Camera3D", true, false):
		cam = n
		break
	if cam == null:
		cam = Camera3D.new()
		root.add_child(cam)
	var c: Dictionary = _spec.get("camera", {})
	if c.is_empty():
		cam.current = true
		return
	# A shot spec owns the camera outright: detach any follow/spring rig so a
	# gameplay controller cannot fight the framing mid-capture.
	var rig := cam.get_parent()
	if rig != null and rig != root and rig.has_method("set_physics_process"):
		rig.set_physics_process(false)
		rig.set_process(false)
	if cam.has_method("set_physics_process"):
		cam.set_physics_process(false)
		cam.set_process(false)

	if c.has("pos"):
		var p: Array = c["pos"]
		cam.global_position = Vector3(p[0], p[1], p[2])
	if c.has("look_at"):
		var l: Array = c["look_at"]
		var tgt := Vector3(l[0], l[1], l[2])
		if not cam.global_position.is_equal_approx(tgt):
			cam.look_at(tgt, Vector3.UP)
	if c.has("fov"): cam.fov = float(c["fov"])
	if c.has("roll"): cam.rotate_object_local(Vector3.FORWARD, deg_to_rad(float(c["roll"])))
	cam.near = float(c.get("near", 0.05))
	cam.far = float(c.get("far", 800.0))
	cam.current = true


func _apply_time_of_day(root: Node) -> void:
	var tod: String = _spec.get("time_of_day", "")
	if tod == "": return
	for n in root.find_children("*", "Node", true, false):
		if n.has_method("apply_time_of_day"):
			n.call("apply_time_of_day", tod)
			return


func _apply_pose(root: Node) -> void:
	var pose: Dictionary = _spec.get("pose", {})
	if pose.is_empty(): return
	for actor_name in pose.keys():
		var actor := root.find_child(str(actor_name), true, false)
		if actor != null and actor.has_method("freeze_at_pose"):
			var v: Variant = pose[actor_name]
			if typeof(v) == TYPE_DICTIONARY:
				actor.call("freeze_at_pose", str(v.get("clip", "idle")), float(v.get("t", 0.0)))
			else:
				actor.call("freeze_at_pose", str(v), 0.0)
