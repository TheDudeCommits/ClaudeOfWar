extends Node3D
## Self-contained key / fill / rim rig + ART_BIBLE §4 post chain.
##
## Only used when `res://scenes/world/world.tscn` is missing. It is deliberately
## a *character* lighting rig, not a level: low raking key, cool sky fill, and a
## hard back-rim, because ART_BIBLE §3 makes rim separation non-negotiable and a
## character with no rim reads as a untextured mannequin no matter how good the
## material response is.

const GROUND_ALBEDO := "res://assets/chars/tex/stage_ground_albedo.png"
const GROUND_NORMAL := "res://assets/chars/tex/stage_ground_normal.png"
const GROUND_ORM := "res://assets/chars/tex/stage_ground_orm.png"

var _env: WorldEnvironment
var _key: DirectionalLight3D
var _rim: SpotLight3D
var _fill: OmniLight3D
var _bounce: OmniLight3D
var _sky_mat: ProceduralSkyMaterial


func _ready() -> void:
	_build_environment()
	_build_lights()
	_build_ground()
	set_recipe("cold_overcast")


# --------------------------------------------------------------- environment

func _build_environment() -> void:
	var e := Environment.new()

	_sky_mat = ProceduralSkyMaterial.new()
	_sky_mat.sun_angle_max = 24.0
	_sky_mat.sun_curve = 0.12
	var sky := Sky.new()
	sky.sky_material = _sky_mat
	sky.radiance_size = Sky.RADIANCE_SIZE_256
	e.background_mode = Environment.BG_SKY
	e.sky = sky
	e.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	e.ambient_light_sky_contribution = 1.0
	e.ambient_light_energy = 1.0
	e.reflected_light_source = Environment.REFLECTION_SOURCE_SKY

	# Bounce light is most of what separates "next-gen" from "hobby project".
	e.sdfgi_enabled = true
	e.sdfgi_use_occlusion = true
	e.sdfgi_bounce_feedback = 0.65
	e.sdfgi_cascades = 4
	e.sdfgi_min_cell_size = 0.05
	e.sdfgi_energy = 1.15

	e.ssao_enabled = true
	e.ssao_radius = 0.6
	e.ssao_intensity = 1.6
	e.ssao_light_affect = 0.25
	e.ssao_detail = 1.0

	e.ssil_enabled = true
	e.ssil_radius = 3.5
	e.ssil_intensity = 1.1
	e.ssil_normal_rejection = 0.4

	e.ssr_enabled = true
	e.ssr_max_steps = 96
	e.ssr_fade_in = 0.4
	e.ssr_fade_out = 2.0
	e.ssr_depth_tolerance = 0.2

	e.volumetric_fog_enabled = true
	e.volumetric_fog_density = 0.028
	e.volumetric_fog_albedo = Color(0.72, 0.78, 0.88)
	e.volumetric_fog_gi_inject = 1.0
	e.volumetric_fog_anisotropy = 0.35
	e.volumetric_fog_length = 90.0
	e.volumetric_fog_detail_spread = 2.0
	e.volumetric_fog_ambient_inject = 0.6

	e.fog_enabled = true
	e.fog_mode = Environment.FOG_MODE_DEPTH
	e.fog_light_color = Color(0.48, 0.56, 0.68)
	e.fog_light_energy = 1.0
	e.fog_sun_scatter = 0.18
	e.fog_density = 0.012
	e.fog_aerial_perspective = 0.7
	e.fog_sky_affect = 0.35
	e.fog_depth_begin = 6.0
	e.fog_depth_end = 140.0
	e.fog_depth_curve = 0.8

	e.glow_enabled = true
	e.glow_intensity = 0.35
	e.glow_bloom = 0.06
	e.glow_strength = 1.0
	e.glow_blend_mode = Environment.GLOW_BLEND_MODE_SOFTLIGHT
	e.glow_hdr_threshold = 0.9
	e.glow_hdr_scale = 2.0
	for i in 7:
		e.set("glow_levels/%d" % (i + 1), [0.0, 0.2, 0.5, 0.9, 1.0, 0.7, 0.4][i])

	e.tonemap_mode = Environment.TONE_MAPPER_ACES
	e.tonemap_white = 6.5
	e.tonemap_exposure = 1.0

	# §5: desaturate off the raw render, never crush blacks.
	e.adjustment_enabled = true
	e.adjustment_brightness = 1.0
	e.adjustment_contrast = 1.06
	e.adjustment_saturation = 0.86

	_env = WorldEnvironment.new()
	_env.name = "StageEnvironment"
	_env.environment = e
	add_child(_env)


# -------------------------------------------------------------------- lights

func _build_lights() -> void:
	_key = DirectionalLight3D.new()
	_key.name = "Key"
	_key.shadow_enabled = true
	_key.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS
	_key.directional_shadow_max_distance = 60.0
	_key.directional_shadow_blend_splits = true
	_key.shadow_bias = 0.035
	_key.shadow_normal_bias = 1.4
	_key.shadow_blur = 1.1
	_key.light_angular_distance = 1.1     # real sun softness; hard shadows read fake
	_key.light_specular = 1.0
	add_child(_key)

	# Back rim. ART_BIBLE §3: "Always a rim/back light separating hero from
	# background. Always." A spot rather than a directional so it only rakes the
	# subject and does not wash the ground plane.
	_rim = SpotLight3D.new()
	_rim.name = "Rim"
	_rim.spot_angle = 34.0
	_rim.spot_angle_attenuation = 0.6
	_rim.spot_range = 22.0
	_rim.shadow_enabled = false
	_rim.light_specular = 1.6
	_rim.position = Vector3(-2.4, 3.0, -3.6)
	add_child(_rim)
	_rim.look_at(Vector3(0.0, 1.35, 0.4), Vector3.UP)

	_fill = OmniLight3D.new()
	_fill.name = "Fill"
	_fill.omni_range = 14.0
	_fill.omni_attenuation = 1.4
	_fill.shadow_enabled = false
	_fill.light_specular = 0.25
	_fill.position = Vector3(2.6, 1.7, 2.8)
	add_child(_fill)

	# Ground bounce — cheap stand-in for the warm floor bounce SDFGI gives at
	# steady state, and it stops the underside of the jaw going flat.
	_bounce = OmniLight3D.new()
	_bounce.name = "Bounce"
	_bounce.omni_range = 6.0
	_bounce.omni_attenuation = 2.0
	_bounce.shadow_enabled = false
	_bounce.light_specular = 0.0
	_bounce.position = Vector3(0.4, 0.25, 1.6)
	add_child(_bounce)


func _build_ground() -> void:
	var mi := MeshInstance3D.new()
	mi.name = "StageGround"
	var pm := PlaneMesh.new()
	pm.size = Vector2(80.0, 80.0)
	pm.subdivide_width = 32
	pm.subdivide_depth = 32
	mi.mesh = pm
	mi.position = Vector3(0.0, 0.0, 0.0)

	var m := StandardMaterial3D.new()
	m.albedo_color = Color(0.30, 0.29, 0.28)
	if ResourceLoader.exists(GROUND_ALBEDO):
		m.albedo_texture = load(GROUND_ALBEDO)
		m.albedo_color = Color(1, 1, 1)
	if ResourceLoader.exists(GROUND_NORMAL):
		m.normal_enabled = true
		m.normal_texture = load(GROUND_NORMAL)
		m.normal_scale = 1.0
	if ResourceLoader.exists(GROUND_ORM):
		var orm: Texture2D = load(GROUND_ORM)
		m.ao_enabled = true
		m.ao_texture = orm
		m.ao_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED
		m.ao_light_affect = 0.6
		m.roughness_texture = orm
		m.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_GREEN
	m.roughness = 1.0
	m.metallic = 0.0
	m.metallic_specular = 0.5
	m.uv1_scale = Vector3(16.0, 16.0, 1.0)
	mi.material_override = m
	add_child(mi)


# --------------------------------------------------------------- time of day

func set_recipe(tod: String) -> void:
	match tod:
		"ember_hellscape", "ember":
			_ember()
		_:
			_cold_overcast()


func _cold_overcast() -> void:
	_key.rotation_degrees = Vector3(-19.0, 38.0, 0.0)
	_key.light_color = Color(1.0, 0.886, 0.745)      # #FFE2BE
	_key.light_energy = 3.4

	_rim.light_color = Color(0.80, 0.87, 1.0)
	_rim.light_energy = 9.0

	_fill.light_color = Color(0.44, 0.55, 0.72)
	_fill.light_energy = 2.4

	_bounce.light_color = Color(0.55, 0.53, 0.47)
	_bounce.light_energy = 1.1

	_sky_mat.sky_top_color = Color(0.243, 0.388, 0.580)      # #3E6394
	_sky_mat.sky_horizon_color = Color(0.561, 0.643, 0.722)  # #8FA4B8
	_sky_mat.ground_bottom_color = Color(0.13, 0.14, 0.15)
	_sky_mat.ground_horizon_color = Color(0.46, 0.50, 0.55)
	_sky_mat.energy_multiplier = 1.0

	var e := _env.environment
	e.volumetric_fog_density = 0.026
	e.volumetric_fog_albedo = Color(0.74, 0.80, 0.90)
	e.volumetric_fog_emission = Color(0.05, 0.07, 0.10)
	e.fog_light_color = Color(0.48, 0.56, 0.68)
	e.adjustment_saturation = 0.86


func _ember() -> void:
	_key.rotation_degrees = Vector3(-14.0, -152.0, 0.0)
	_key.light_color = Color(1.0, 0.55, 0.24)
	_key.light_energy = 4.2

	_rim.light_color = Color(1.0, 0.62, 0.30)
	_rim.light_energy = 14.0

	_fill.light_color = Color(0.478, 0.239, 0.561)   # #7A3D8F
	_fill.light_energy = 4.0

	_bounce.light_color = Color(0.85, 0.34, 0.12)
	_bounce.light_energy = 2.2

	_sky_mat.sky_top_color = Color(0.10, 0.07, 0.11)
	_sky_mat.sky_horizon_color = Color(0.42, 0.20, 0.17)
	_sky_mat.ground_bottom_color = Color(0.06, 0.04, 0.05)
	_sky_mat.ground_horizon_color = Color(0.30, 0.13, 0.11)
	_sky_mat.energy_multiplier = 0.9

	var e := _env.environment
	e.volumetric_fog_density = 0.075
	e.volumetric_fog_albedo = Color(0.62, 0.36, 0.26)
	e.volumetric_fog_emission = Color(0.16, 0.055, 0.02)
	e.fog_light_color = Color(0.40, 0.20, 0.22)
	e.adjustment_saturation = 0.92
