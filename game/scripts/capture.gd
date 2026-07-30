extends Node
# Headless-ish capture harness: renders N warmup frames then dumps a PNG and quits.
func _ready() -> void:
	var out := "user://shot.png"
	var warm := 30
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--out="): out = a.substr(6)
		elif a.begins_with("--warm="): warm = int(a.substr(7))
	for i in warm:
		await RenderingServer.frame_post_draw
	var img := get_viewport().get_texture().get_image()
	var err := img.save_png(out)
	print("CAPTURE ", "OK" if err == OK else "FAIL", " -> ", out, " ", img.get_width(), "x", img.get_height())
	get_tree().quit(0 if err == OK else 1)
