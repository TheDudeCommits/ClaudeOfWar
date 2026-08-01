extends "res://scripts/chars/character_base.gd"
## Draugr — Norse undead, 1.90 m, hunched.
##
## ART_BIBLE §9: dry roughness on bone and rotted wool, greasy specular on the
## exposed hide, and emissive sockets/fractures so the silhouette still reads
## when the character is standing in volumetric fog.
##
## Pose space matches the hero: mesh faces +Z, positive X leans forward.

const TEX := "res://assets/chars/zombie/"

var _body_mat: StandardMaterial3D


func default_clip() -> String:
	return "lurch"


func bone_overrides() -> Dictionary:
	return {"spine": "Spine02", "chest": "Spine01", "upperchest": "Spine"}


# ------------------------------------------------------------------ materials

func _rebuild_materials() -> void:
	_body_mat = StandardMaterial3D.new()
	_body_mat.resource_name = "draugr_body"

	_body_mat.albedo_texture = _tex("albedo.png")
	_body_mat.albedo_color = Color(1, 1, 1)

	_body_mat.roughness = 1.0
	_body_mat.roughness_texture = _tex("roughness.png")
	_body_mat.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED

	_body_mat.metallic = 1.0
	_body_mat.metallic_texture = _tex("metallic.png")
	_body_mat.metallic_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED
	_body_mat.metallic_specular = 0.45

	_body_mat.normal_enabled = true
	_body_mat.normal_texture = _tex("normal.png")
	_body_mat.normal_scale = 1.6      # harder than the hero: desiccation is sharp

	_body_mat.ao_enabled = true
	_body_mat.ao_texture = _tex("ao.png")
	_body_mat.ao_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED
	_body_mat.ao_light_affect = 0.55

	# Even a corpse scatters — thin dried hide over bone is *more* translucent
	# at the ears and fingers than living skin, not less. Weaker and colder than
	# the hero's so it never reads as healthy flesh.
	_body_mat.subsurf_scatter_enabled = true
	_body_mat.subsurf_scatter_strength = 0.22
	_body_mat.subsurf_scatter_skin_mode = true
	_body_mat.subsurf_scatter_texture = _tex("sss.png")
	_body_mat.subsurf_scatter_transmittance_enabled = true
	_body_mat.subsurf_scatter_transmittance_color = Color(0.62, 0.42, 0.32)
	_body_mat.subsurf_scatter_transmittance_depth = 0.22
	_body_mat.subsurf_scatter_transmittance_boost = 0.35

	# Sockets and rune fractures. Above 1.0 so the glow pass catches them.
	_body_mat.emission_enabled = true
	_body_mat.emission = Color(0.45, 0.78, 1.0)
	_body_mat.emission_energy_multiplier = 3.2
	_body_mat.emission_texture = _tex("emission.png")
	_body_mat.emission_operator = BaseMaterial3D.EMISSION_OP_MULTIPLY

	_body_mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	_body_mat.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC

	var n := apply_material("*", _body_mat)
	print("[zombie] rebuilt %d surface(s): %s" % [n, surface_names()])
	_build_socket_glow()


func _tex(f: String) -> Texture2D:
	var p := TEX + f
	if not ResourceLoader.exists(p):
		push_warning("zombie: missing texture " + p)
		return null
	return load(p)


func _build_socket_glow() -> void:
	## A tiny light inside the skull. The emissive texture alone lights nothing;
	## this is what puts cold bounce onto the brow ridge and cheekbones and sells
	## the sockets as a light source rather than a bright decal.
	if skeleton == null or not has_bone("head") or skeleton.has_node("SocketGlow"):
		return
	var head_i: int = _bone_idx["head"]
	var attach := BoneAttachment3D.new()
	attach.name = "SocketGlow"
	skeleton.add_child(attach)
	attach.bone_name = skeleton.get_bone_name(head_i)
	attach.bone_idx = head_i

	var l := OmniLight3D.new()
	l.name = "SocketLight"
	l.light_color = Color(0.42, 0.76, 1.0)
	l.light_energy = 1.6
	l.omni_range = 0.42
	l.omni_attenuation = 2.2
	l.shadow_enabled = false
	l.light_specular = 0.6
	var world := Vector3(0.0, 1.735, 0.10)
	l.transform = Transform3D(Basis.IDENTITY,
		skeleton.get_bone_global_rest(head_i).affine_inverse() * world)
	attach.add_child(l)


# --------------------------------------------------------------------- poses

func pose_library() -> Dictionary:
	return {
		# Shambling advance: weight forward over a dragging leg, head cocked and
		# dropped below the shoulder line, arms hanging heavy and slightly out.
		"lurch": [
			{"t": 0.0, "pose": {
				"hips": Vector3(9, 7, 2),
				"spine": Vector3(11, 5, -2), "chest": Vector3(10, 4, -3),
				"upperchest": Vector3(7, 3, -2),
				"neck": Vector3(10, -8, 5), "head": Vector3(6, -12, 9),
				"shoulderl": Vector3(-8, 4, -14), "shoulderr": Vector3(-6, -4, 10),
				"arml": Vector3(-16, 6, 12), "armr": Vector3(-22, -6, -9),
				"forearml": Vector3(-34, 0, 0), "forearmr": Vector3(-46, 0, 0),
				"handl": Vector3(-18, 0, 0), "handr": Vector3(-24, 0, 0),
				"uplegl": Vector3(-20, 3, 3), "uplegr": Vector3(13, -3, -2),
				"legl": Vector3(26, 0, 0), "legr": Vector3(-14, 0, 0),
				"footl": Vector3(-10, 0, 0), "footr": Vector3(10, 0, 0),
			}},
			{"t": 1.0, "pose": {
				"hips": Vector3(12, 10, 3),
				"spine": Vector3(14, 7, -3), "chest": Vector3(12, 6, -4),
				"upperchest": Vector3(9, 4, -3),
				"neck": Vector3(12, -12, 7), "head": Vector3(4, -16, 12),
				"shoulderl": Vector3(-11, 6, -18), "shoulderr": Vector3(-8, -6, 13),
				"arml": Vector3(-26, 9, 16), "armr": Vector3(-34, -9, -12),
				"forearml": Vector3(-44, 0, 0), "forearmr": Vector3(-58, 0, 0),
				"handl": Vector3(-22, 0, 0), "handr": Vector3(-30, 0, 0),
				"uplegl": Vector3(-27, 4, 3), "uplegr": Vector3(18, -4, -2),
				"legl": Vector3(34, 0, 0), "legr": Vector3(-19, 0, 0),
				"footl": Vector3(-13, 0, 0), "footr": Vector3(14, 0, 0),
			}},
		],
		# Head thrown back, chest open, arms flung wide and behind.
		"roar": [
			{"t": 0.0, "pose": {
				"hips": Vector3(6, 0, 0),
				"spine": Vector3(-6, 0, 0), "chest": Vector3(-9, 0, 0),
				"upperchest": Vector3(-7, 0, 0),
				"neck": Vector3(-16, 3, 0), "head": Vector3(-20, 4, -2),
				"shoulderl": Vector3(10, 0, -18), "shoulderr": Vector3(10, 0, 16),
				"arml": Vector3(22, -14, -26), "armr": Vector3(22, 14, 24),
				"forearml": Vector3(-30, 0, 0), "forearmr": Vector3(-30, 0, 0),
				"uplegl": Vector3(-12, 0, 5), "uplegr": Vector3(10, 0, -5),
				"legl": Vector3(16, 0, 0), "legr": Vector3(-6, 0, 0),
			}},
			{"t": 1.0, "pose": {
				"hips": Vector3(8, 0, 0),
				"spine": Vector3(-9, 0, 0), "chest": Vector3(-13, 0, 0),
				"upperchest": Vector3(-10, 0, 0),
				"neck": Vector3(-22, 4, 0), "head": Vector3(-27, 6, -3),
				"shoulderl": Vector3(14, 0, -24), "shoulderr": Vector3(14, 0, 22),
				"arml": Vector3(30, -20, -34), "armr": Vector3(30, 20, 32),
				"forearml": Vector3(-40, 0, 0), "forearmr": Vector3(-40, 0, 0),
				"uplegl": Vector3(-16, 0, 5), "uplegr": Vector3(14, 0, -5),
				"legl": Vector3(22, 0, 0), "legr": Vector3(-8, 0, 0),
			}},
		],
		"idle": [
			{"t": 0.0, "pose": {
				"hips": Vector3(5, 2, 1),
				"spine": Vector3(7, 2, -1), "chest": Vector3(6, 2, -2),
				"neck": Vector3(7, -4, 3), "head": Vector3(4, -6, 5),
				"arml": Vector3(-8, 0, 8), "armr": Vector3(-10, 0, -7),
				"forearml": Vector3(-22, 0, 0), "forearmr": Vector3(-26, 0, 0),
				"uplegl": Vector3(-6, 0, 2), "uplegr": Vector3(5, 0, -2),
				"legl": Vector3(10, 0, 0), "legr": Vector3(-4, 0, 0),
			}},
		],
	}
