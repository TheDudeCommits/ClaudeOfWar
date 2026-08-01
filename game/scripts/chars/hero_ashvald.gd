extends "res://scripts/chars/character_base.gd"
## Ashvald — anime-styled Norse fighter, 1.80 m.
##
## Mesh comes from a Higgsfield/Meshy image-to-3D pass; everything about how it
## *renders* is authored here. The imported glTF material is fully emissive with
## metallic 1.0, roughness 1.0 and no normal map, which is three separate §12
## instant-fails, so it is discarded outright rather than tweaked.
##
## Pose space: this mesh faces +Z (eyes sit at z = +0.20), so a positive X
## rotation leans the character forward and a positive Y rotation turns it
## toward its +X side.

const TEX := "res://assets/chars/hero/"

# Eye centres in model space, taken from the eye-texel cluster the atlas
# analysis found and mirrored to kill the generator's asymmetry.
const EYE_X := 0.0357
const EYE_Y := 1.6164
const EYE_Z := 0.2045
const EYE_R := 0.0142

var _body_mat: StandardMaterial3D
var _cornea_mat: StandardMaterial3D


func default_clip() -> String:
	return "portrait"


func bone_overrides() -> Dictionary:
	# Meshy's chain is Hips -> Spine02 -> Spine01 -> Spine -> {shoulders, neck},
	# i.e. the numbering runs the opposite way to every other rig.
	return {"spine": "Spine02", "chest": "Spine01", "upperchest": "Spine"}


# ------------------------------------------------------------------ materials

func _rebuild_materials() -> void:
	_body_mat = StandardMaterial3D.new()
	_body_mat.resource_name = "ashvald_body"

	_body_mat.albedo_texture = _tex("albedo.png")
	_body_mat.albedo_color = Color(1, 1, 1)

	# Roughness is a full map with ~0.14 stddev of real variation. A constant
	# here is ART_BIBLE §12.5 and reads as plastic under any raking light.
	_body_mat.roughness = 1.0
	_body_mat.roughness_texture = _tex("roughness.png")
	_body_mat.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED

	# Strictly 0 or 1, via a hard mask — steel pauldron and bronze knotwork are
	# metal, skin and leather are not, and nothing sits in between.
	_body_mat.metallic = 1.0
	_body_mat.metallic_texture = _tex("metallic.png")
	_body_mat.metallic_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED
	_body_mat.metallic_specular = 0.5

	_body_mat.normal_enabled = true
	_body_mat.normal_texture = _tex("normal.png")
	_body_mat.normal_scale = 1.15

	_body_mat.ao_enabled = true
	_body_mat.ao_texture = _tex("ao.png")
	_body_mat.ao_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED
	_body_mat.ao_light_affect = 0.45

	# Skin. Masked so leather and steel do not scatter light like flesh.
	_body_mat.subsurf_scatter_enabled = true
	_body_mat.subsurf_scatter_strength = 0.36
	_body_mat.subsurf_scatter_skin_mode = true
	_body_mat.subsurf_scatter_texture = _tex("sss.png")
	_body_mat.subsurf_scatter_transmittance_enabled = true
	_body_mat.subsurf_scatter_transmittance_color = Color(0.769, 0.329, 0.290)  # #C4544A
	_body_mat.subsurf_scatter_transmittance_depth = 0.30
	_body_mat.subsurf_scatter_transmittance_boost = 0.25

	# Masked rim + backlight, hair only (plus a whisper on skin for ear edges).
	# ART_BIBLE §8 rules out a hard cel ramp but explicitly allows a subtle rim;
	# without light transmitting through the hair edges the sculpted mass reads
	# as a moulded shell. Both are masked by texture so the leather stays matte.
	var rim_tex := _tex("rim.png")
	if rim_tex != null:
		_body_mat.rim_enabled = true
		_body_mat.rim = 0.18
		_body_mat.rim_tint = 0.45
		_body_mat.rim_texture = rim_tex
	var back_tex := _tex("backlight.png")
	if back_tex != null:
		_body_mat.backlight_enabled = true
		_body_mat.backlight = Color(1, 1, 1)
		_body_mat.backlight_texture = back_tex

	# The cape and the hair shells are single-sided geometry.
	_body_mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	_body_mat.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
	_body_mat.texture_repeat = true

	var n := apply_material("*", _body_mat)
	print("[hero] rebuilt %d surface(s): %s" % [n, surface_names()])

	_build_eyes()


func _tex(f: String) -> Texture2D:
	var p := TEX + f
	if not ResourceLoader.exists(p):
		push_warning("hero: missing texture " + p)
		return null
	return load(p)


# ---------------------------------------------------------------------- eyes

func _build_eyes() -> void:
	## The generated mesh paints eyes into the albedo but has no cornea, so the
	## one thing every real close-up has — a specular catchlight — is missing.
	## A thin glossy shell over each painted eye restores it without having to
	## match the painted iris art.
	if skeleton == null or not has_bone("head"):
		push_warning("hero: no head bone, skipping cornea")
		return
	if skeleton.has_node("EyeAttach"):
		return

	_cornea_mat = StandardMaterial3D.new()
	_cornea_mat.resource_name = "ashvald_cornea"
	_cornea_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	# Alpha scales the *whole* fragment, specular included. At 0.055 the
	# catchlight was being multiplied down to nothing, which is why the first
	# lit pass had flat painted eyes. 0.34 keeps the painted iris readable
	# underneath while letting the highlight through at full strength.
	_cornea_mat.albedo_color = Color(0.06, 0.07, 0.09, 0.34)
	_cornea_mat.roughness = 0.02
	_cornea_mat.metallic = 0.0
	_cornea_mat.metallic_specular = 1.0
	_cornea_mat.clearcoat_enabled = true
	_cornea_mat.clearcoat = 1.0
	_cornea_mat.clearcoat_roughness = 0.01
	_cornea_mat.rim_enabled = true
	_cornea_mat.rim = 0.6
	_cornea_mat.rim_tint = 0.0
	_cornea_mat.refraction_enabled = false
	_cornea_mat.no_depth_test = false
	_cornea_mat.disable_receive_shadows = true
	_cornea_mat.shading_mode = BaseMaterial3D.SHADING_MODE_PER_PIXEL

	var head_i: int = _bone_idx["head"]
	var head_rest := skeleton.get_bone_global_rest(head_i)

	var attach := BoneAttachment3D.new()
	attach.name = "EyeAttach"
	skeleton.add_child(attach)
	attach.bone_name = skeleton.get_bone_name(head_i)
	attach.bone_idx = head_i

	var sphere := SphereMesh.new()
	sphere.radius = EYE_R
	sphere.height = EYE_R * 2.0
	sphere.radial_segments = 24
	sphere.rings = 12

	for sign in [-1.0, 1.0]:
		var mi := MeshInstance3D.new()
		mi.name = "Cornea%s" % ("L" if sign > 0.0 else "R")
		mi.mesh = sphere
		mi.material_override = _cornea_mat
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		# Centre sits just behind the painted eye so only a ~2 mm cap of cornea
		# stands proud of the socket.
		var world := Vector3(EYE_X * sign, EYE_Y, EYE_Z - EYE_R + 0.0025)
		mi.transform = Transform3D(Basis.IDENTITY, head_rest.affine_inverse() * world)
		attach.add_child(mi)


# --------------------------------------------------------------------- poses

func pose_library() -> Dictionary:
	return {
		# Head-and-shoulders framing. Chin a touch up, head turned off-axis:
		# a dead-on symmetric portrait reads as a character-select mannequin.
		"portrait": [
			{"t": 0.0, "pose": {
				"spine": Vector3(1, -3, 1), "chest": Vector3(2, -4, -1),
				"upperchest": Vector3(1, -3, 2),
				"neck": Vector3(3, 9, -2), "head": Vector3(-6, 8, 3),
				"shoulderl": Vector3(0, 0, -7), "shoulderr": Vector3(0, 0, 5),
				"arml": Vector3(0, 0, 16), "armr": Vector3(0, 0, -14),
				"forearml": Vector3(-22, 0, 0), "forearmr": Vector3(-18, 0, 0),
			}},
			{"t": 1.0, "pose": {
				"spine": Vector3(2, -5, 1), "chest": Vector3(3, -6, -1),
				"upperchest": Vector3(1, -5, 2),
				"neck": Vector3(1, 13, -3), "head": Vector3(-4, 11, 4),
				"shoulderl": Vector3(0, 0, -9), "shoulderr": Vector3(0, 0, 6),
				"arml": Vector3(0, 0, 18), "armr": Vector3(0, 0, -16),
				"forearml": Vector3(-28, 0, 0), "forearmr": Vector3(-22, 0, 0),
			}},
		],
		# Weight forward, guard up, shoulders squared to the threat.
		"guard": [
			{"t": 0.0, "pose": {
				"hips": Vector3(4, -6, 0),
				"spine": Vector3(5, -6, 1), "chest": Vector3(4, -8, -2),
				"upperchest": Vector3(2, -6, 2),
				"neck": Vector3(-2, 10, -2), "head": Vector3(-8, 6, 2),
				"shoulderl": Vector3(-4, 0, -12), "shoulderr": Vector3(-2, 0, 8),
				"arml": Vector3(-8, 0, 26), "armr": Vector3(-14, 0, -22),
				"forearml": Vector3(-52, 0, 0), "forearmr": Vector3(-64, 0, 0),
				"uplegl": Vector3(-14, 0, 4), "uplegr": Vector3(16, 0, -3),
				"legl": Vector3(22, 0, 0), "legr": Vector3(-8, 0, 0),
			}},
			{"t": 1.0, "pose": {
				"hips": Vector3(6, -8, 0),
				"spine": Vector3(7, -8, 1), "chest": Vector3(5, -10, -2),
				"upperchest": Vector3(3, -8, 2),
				"neck": Vector3(-3, 12, -2), "head": Vector3(-9, 8, 2),
				"shoulderl": Vector3(-6, 0, -14), "shoulderr": Vector3(-3, 0, 10),
				"arml": Vector3(-10, 0, 30), "armr": Vector3(-18, 0, -26),
				"forearml": Vector3(-60, 0, 0), "forearmr": Vector3(-74, 0, 0),
				"uplegl": Vector3(-18, 0, 4), "uplegr": Vector3(20, 0, -3),
				"legl": Vector3(26, 0, 0), "legr": Vector3(-10, 0, 0),
			}},
		],
		"idle": [
			{"t": 0.0, "pose": {
				"spine": Vector3(1, -2, 0), "chest": Vector3(1, -2, 0),
				"neck": Vector3(2, 3, 0), "head": Vector3(-3, 2, 0),
				"arml": Vector3(0, 0, 14), "armr": Vector3(0, 0, -12),
				"forearml": Vector3(-14, 0, 0), "forearmr": Vector3(-12, 0, 0),
			}},
		],
	}
