extends Node
## Thin dispatcher. In capture mode CaptureRig owns the boot and loads the shot's
## scene, so we must not race it. Otherwise fall through to the playable arena.

const PLAY_SCENE := "res://scenes/arena/arena.tscn"


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--shot="):
			return  # CaptureRig drives scene loading
	if ResourceLoader.exists(PLAY_SCENE):
		get_tree().change_scene_to_file(PLAY_SCENE)
	else:
		push_warning("arena scene not built yet: " + PLAY_SCENE)
