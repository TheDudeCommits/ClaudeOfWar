extends Node3D
## ClaudeOfWar world rig — lighting + atmosphere + post stack in one droppable node.
##
## Instance `res://scenes/world/world.tscn` at the top of any level scene and the
## whole ART_BIBLE 4 chain comes with it: SSAO -> SSIL -> SSR -> volumetric fog ->
## auto exposure -> glow -> ACES -> grade -> DOF -> CA/grain/vignette/sharpen.
##
## `apply_time_of_day("cold_overcast" | "ember_hellscape")` reconfigures sun, rim,
## fill, sky, both fog systems, glow and the grade in one call. The capture harness
## (scripts/capture_rig.gd) finds this node by duck-typing that method name, so do
## not rename it.

const COLD := "cold_overcast"
const EMBER := "ember_hellscape"

@export_enum("cold_overcast", "ember_hellscape") var time_of_day: String = COLD
@export var animate_grain: bool = true

var _preset: String = ""


func _ready() -> void:
	apply_time_of_day(time_of_day)


func _process(_delta: float) -> void:
	if not animate_grain:
		return
	var mat: ShaderMaterial = _grade_material()
	if mat != null:
		mat.set_shader_parameter("grain_time", float(Time.get_ticks_msec()) * 0.001)


func current_time_of_day() -> String:
	return _preset


# ---------------------------------------------------------------------------
# public entry point
# ---------------------------------------------------------------------------

func apply_time_of_day(p_name: String) -> void:
	var key := p_name.strip_edges().to_lower()
	if key != COLD and key != EMBER:
		push_warning("world: unknown time_of_day '%s', falling back to %s" % [p_name, COLD])
		key = COLD
	_preset = key
	time_of_day = key

	var env: Environment = _env()
	if env == null:
		push_error("world: WorldEnvironment has no Environment resource")
		return

	_apply_common(env)
	if key == COLD:
		_apply_cold_overcast(env)
	else:
		_apply_ember_hellscape(env)


# ---------------------------------------------------------------------------
# preset: 3a "Cold Overcast Ruin"
# ---------------------------------------------------------------------------

func _apply_cold_overcast(env: Environment) -> void:
	# --- sun: low raking three-quarter back key -----------------------------
	# Elevation 17 deg (bible: 15-25, never >35). Azimuth -128 puts the sun
	# behind-left of the subject so it rims the silhouette and throws a ~6 m
	# shadow toward camera-right.
	var sun: DirectionalLight3D = _sun()
	_aim(sun, 17.0, -118.0)
	sun.light_color = _srgb("#FFE0BC")
	sun.light_energy = 3.6
	sun.light_indirect_energy = 1.2
	sun.light_volumetric_fog_energy = 0.7
	sun.light_specular = 1.0
	sun.light_angular_distance = 0.9     # hazy disc -> soft penumbra
	sun.shadow_enabled = true
	_tune_shadows(sun, 0.026, 1.15, 1.0)

	# --- rim: kicker from the far side, grazes the camera-side silhouette ---
	var rim: DirectionalLight3D = _rim()
	rim.visible = true
	_aim(rim, 12.0, 158.0)
	rim.light_color = _srgb("#CFE0F5")
	rim.light_energy = 0.85
	rim.light_specular = 0.9
	rim.light_indirect_energy = 0.0
	rim.shadow_enabled = false

	# --- fill: camera-side skylight so shadow sides never read black -------
	var fill: DirectionalLight3D = _fill()
	fill.visible = true
	_aim(fill, 30.0, 42.0)
	fill.light_color = _srgb("#5A6E88")
	fill.light_energy = 0.18
	fill.light_specular = 0.12
	fill.light_indirect_energy = 0.0
	fill.shadow_enabled = false

	# --- sky ---------------------------------------------------------------
	var sky: ProceduralSkyMaterial = _sky_material()
	if sky != null:
		sky.sky_top_color = _srgb("#0E3E82")
		sky.sky_horizon_color = _srgb("#6E88A4")
		sky.sky_curve = 0.55
		sky.sky_energy_multiplier = 2.6
		sky.ground_bottom_color = _srgb("#232A33")
		sky.ground_horizon_color = _srgb("#6E7A88")
		sky.ground_curve = 0.05
		sky.ground_energy_multiplier = 0.45
		sky.sun_angle_max = 8.0
		sky.sun_curve = 0.04
		sky.sky_cover_modulate = Color(1, 1, 1, 0)

	# --- ambient / GI ------------------------------------------------------
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.ambient_light_sky_contribution = 1.0
	env.ambient_light_color = _srgb("#5A6E88")
	env.ambient_light_energy = 0.28
	env.reflected_light_source = Environment.REFLECTION_SOURCE_SKY

	env.sdfgi_enabled = true
	env.sdfgi_energy = 1.0
	env.sdfgi_bounce_feedback = 0.5
	env.sdfgi_min_cell_size = 0.14
	env.sdfgi_cascades = 6
	env.sdfgi_use_occlusion = true

	# --- depth fog (aerial perspective) ------------------------------------
	env.fog_enabled = true
	env.fog_mode = Environment.FOG_MODE_EXPONENTIAL
	env.fog_light_color = _srgb("#8397AC")
	env.fog_light_energy = 0.7
	env.fog_sun_scatter = 0.12
	env.fog_density = 0.0075
	env.fog_aerial_perspective = 1.0
	env.fog_sky_affect = 0.0
	env.fog_height = 12.0
	env.fog_height_density = 0.012

	# --- volumetric fog (god rays) -----------------------------------------
	# Kept deliberately thin and short-range: it is here for shafts and for the
	# soft halo around light sources, not for depth. Depth is the exponential
	# fog above. Density * length is the optical depth — >1.5 and the frame goes
	# milk-white, which is what killed round 1.
	env.volumetric_fog_enabled = true
	env.volumetric_fog_density = 0.0048
	env.volumetric_fog_albedo = _srgb("#B9CCE0")
	env.volumetric_fog_emission = _srgb("#000000")
	env.volumetric_fog_emission_energy = 0.0
	env.volumetric_fog_gi_inject = 0.6
	env.volumetric_fog_anisotropy = 0.35
	env.volumetric_fog_length = 70.0
	env.volumetric_fog_detail_spread = 2.0
	env.volumetric_fog_ambient_inject = 0.12
	env.volumetric_fog_sky_affect = 0.0

	# --- glow --------------------------------------------------------------
	env.glow_intensity = 0.40
	env.glow_strength = 1.0
	env.glow_bloom = 0.04
	env.glow_hdr_threshold = 0.92
	env.glow_hdr_scale = 2.0
	env.glow_hdr_luminance_cap = 12.0

	# --- environment-level grade -------------------------------------------
	env.adjustment_enabled = true
	env.adjustment_brightness = 1.0
	env.adjustment_contrast = 1.03
	env.adjustment_saturation = 1.0

	# --- exposure ----------------------------------------------------------
	env.tonemap_exposure = 0.56

	var cam: CameraAttributesPractical = _camera_attributes()
	if cam != null:
		cam.exposure_multiplier = 1.0
		cam.auto_exposure_scale = 0.35
		cam.auto_exposure_min_sensitivity = 78.0
		cam.auto_exposure_max_sensitivity = 130.0

	# --- film pass ---------------------------------------------------------
	var g: ShaderMaterial = _grade_material()
	if g != null:
		g.set_shader_parameter("exposure_bias", 1.0)
		g.set_shader_parameter("contrast", 0.26)
		g.set_shader_parameter("saturation", 0.86)
		g.set_shader_parameter("black_point", _srgb("#0C1016"))
		g.set_shader_parameter("shadow_tint", _srgb("#33606B"))
		g.set_shader_parameter("highlight_tint", _srgb("#FFD9A8"))
		g.set_shader_parameter("shadow_tint_strength", 0.30)
		g.set_shader_parameter("highlight_tint_strength", 0.10)
		g.set_shader_parameter("ca_amount", 0.0032)
		g.set_shader_parameter("sharpen_amount", 0.38)
		g.set_shader_parameter("grain_amount", 0.020)
		g.set_shader_parameter("grain_size", 1.35)
		g.set_shader_parameter("vignette_amount", 0.30)
		g.set_shader_parameter("vignette_inner", 0.26)
		g.set_shader_parameter("vignette_ellipse", 1.10)


# ---------------------------------------------------------------------------
# preset: 3b "Ember Hellscape"
# ---------------------------------------------------------------------------

func _apply_ember_hellscape(env: Environment) -> void:
	# --- sun: near-horizon ember key, hard from behind ----------------------
	var sun: DirectionalLight3D = _sun()
	_aim(sun, 9.0, -156.0)
	sun.light_color = _srgb("#FFA45C")
	sun.light_energy = 3.6
	sun.light_indirect_energy = 1.0
	sun.light_volumetric_fog_energy = 1.0
	sun.light_specular = 1.0
	sun.light_angular_distance = 2.2
	sun.shadow_enabled = true
	_tune_shadows(sun, 0.042, 1.6, 0.90)

	# --- rim: the complementary magenta/violet split, opposite the key ------
	var rim: DirectionalLight3D = _rim()
	rim.visible = true
	_aim(rim, 14.0, 156.0)
	rim.light_color = _srgb("#9E5CC8")
	rim.light_energy = 1.05
	rim.light_specular = 0.9
	rim.light_indirect_energy = 0.0
	rim.shadow_enabled = false

	# --- fill: low fire bounce from the camera side ------------------------
	var fill: DirectionalLight3D = _fill()
	fill.visible = true
	_aim(fill, 12.0, 34.0)
	fill.light_color = _srgb("#8E5A48")
	fill.light_energy = 0.55
	fill.light_specular = 0.2
	fill.light_indirect_energy = 0.0
	fill.shadow_enabled = false

	# --- sky ---------------------------------------------------------------
	var sky: ProceduralSkyMaterial = _sky_material()
	if sky != null:
		sky.sky_top_color = _srgb("#241E30")
		sky.sky_horizon_color = _srgb("#8C5C4C")
		sky.sky_curve = 0.30
		sky.sky_energy_multiplier = 1.1
		sky.ground_bottom_color = _srgb("#160D14")
		sky.ground_horizon_color = _srgb("#4A2320")
		sky.ground_curve = 0.06
		sky.ground_energy_multiplier = 0.35
		sky.sun_angle_max = 12.0
		sky.sun_curve = 0.05
		sky.sky_cover_modulate = Color(1, 1, 1, 0)

	# --- ambient / GI ------------------------------------------------------
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.ambient_light_sky_contribution = 0.25
	env.ambient_light_color = _srgb("#4A4A56")
	env.ambient_light_energy = 0.85
	env.reflected_light_source = Environment.REFLECTION_SOURCE_SKY

	env.sdfgi_enabled = true
	env.sdfgi_energy = 1.15
	env.sdfgi_bounce_feedback = 0.6
	env.sdfgi_min_cell_size = 0.14
	env.sdfgi_cascades = 6
	env.sdfgi_use_occlusion = true

	# --- depth fog ---------------------------------------------------------
	env.fog_enabled = true
	env.fog_mode = Environment.FOG_MODE_EXPONENTIAL
	env.fog_light_color = _srgb("#5E4C58")
	env.fog_light_energy = 0.85
	env.fog_sun_scatter = 0.24
	env.fog_density = 0.015
	env.fog_aerial_perspective = 1.0
	env.fog_sky_affect = 0.15
	env.fog_height = 14.0
	env.fog_height_density = 0.02

	# --- volumetric fog: heavy, warm, smoke-like ---------------------------
	env.volumetric_fog_enabled = true
	env.volumetric_fog_density = 0.018
	env.volumetric_fog_albedo = _srgb("#8A7A84")
	env.volumetric_fog_emission = _srgb("#5A2410")
	env.volumetric_fog_emission_energy = 0.05
	env.volumetric_fog_gi_inject = 0.7
	env.volumetric_fog_anisotropy = 0.5
	env.volumetric_fog_length = 70.0
	env.volumetric_fog_detail_spread = 2.4
	env.volumetric_fog_ambient_inject = 0.2
	env.volumetric_fog_sky_affect = 0.0

	# --- glow: emissives everywhere ----------------------------------------
	env.glow_intensity = 0.38
	env.glow_strength = 1.0
	env.glow_bloom = 0.03
	env.glow_hdr_threshold = 1.0
	env.glow_hdr_scale = 2.2
	env.glow_hdr_luminance_cap = 14.0

	env.adjustment_enabled = true
	env.adjustment_brightness = 1.0
	env.adjustment_contrast = 1.05
	env.adjustment_saturation = 0.88

	env.tonemap_exposure = 0.78

	var cam: CameraAttributesPractical = _camera_attributes()
	if cam != null:
		cam.exposure_multiplier = 1.0
		cam.auto_exposure_scale = 0.35
		cam.auto_exposure_min_sensitivity = 80.0
		cam.auto_exposure_max_sensitivity = 140.0

	var g: ShaderMaterial = _grade_material()
	if g != null:
		g.set_shader_parameter("exposure_bias", 1.0)
		g.set_shader_parameter("contrast", 0.26)
		g.set_shader_parameter("saturation", 0.70)
		g.set_shader_parameter("black_point", _srgb("#100A14"))
		g.set_shader_parameter("shadow_tint", _srgb("#4A2A6E"))
		g.set_shader_parameter("highlight_tint", _srgb("#FFC084"))
		g.set_shader_parameter("shadow_tint_strength", 0.32)
		g.set_shader_parameter("highlight_tint_strength", 0.18)
		g.set_shader_parameter("ca_amount", 0.0040)
		g.set_shader_parameter("sharpen_amount", 0.34)
		g.set_shader_parameter("grain_amount", 0.028)
		g.set_shader_parameter("grain_size", 1.30)
		g.set_shader_parameter("vignette_amount", 0.32)
		g.set_shader_parameter("vignette_inner", 0.24)
		g.set_shader_parameter("vignette_ellipse", 1.14)


# ---------------------------------------------------------------------------
# shared chain (ART_BIBLE 4 — order is the order Godot evaluates it in)
# ---------------------------------------------------------------------------

func _apply_common(env: Environment) -> void:
	env.background_mode = Environment.BG_SKY
	_shape_clouds()

	# SSAO — contact darkening
	env.ssao_enabled = true
	env.ssao_radius = 0.6
	env.ssao_intensity = 1.6
	env.ssao_power = 1.35
	env.ssao_detail = 0.55
	env.ssao_horizon = 0.06
	env.ssao_sharpness = 0.98
	env.ssao_light_affect = 0.25       # AO must not touch direct light -> no black holes
	env.ssao_ao_channel_affect = 0.0

	# SSIL — short range colour bleed
	env.ssil_enabled = true
	env.ssil_radius = 3.5
	env.ssil_intensity = 1.1
	env.ssil_sharpness = 0.98
	env.ssil_normal_rejection = 1.0

	# SSR — wet stone / metal / ice
	env.ssr_enabled = true
	env.ssr_max_steps = 96
	env.ssr_fade_in = 0.2
	env.ssr_fade_out = 2.0
	env.ssr_depth_tolerance = 0.25

	# Tonemap — ACES is mandatory. tonemap_exposure is THE master brightness
	# knob: auto-exposure is deliberately clamped to a narrow band so it only
	# stabilises, and the absolute level is set here, per preset.
	env.tonemap_mode = Environment.TONE_MAPPER_ACES
	env.tonemap_white = 6.5

	# Glow — 7 levels, weighted toward the wide ones for a soft halo
	env.glow_enabled = true
	env.glow_normalized = false
	env.glow_blend_mode = Environment.GLOW_BLEND_MODE_SCREEN
	env.set("glow_levels/1", 0.15)
	env.set("glow_levels/2", 0.35)
	env.set("glow_levels/3", 0.60)
	env.set("glow_levels/4", 0.90)
	env.set("glow_levels/5", 1.00)
	env.set("glow_levels/6", 0.85)
	env.set("glow_levels/7", 0.55)

	# Depth of field + auto exposure live on CameraAttributes in Godot 4.
	var cam: CameraAttributesPractical = _camera_attributes()
	if cam != null:
		cam.auto_exposure_enabled = true
		cam.auto_exposure_speed = 1.2
		# focus sits on the combat plane; hero shoulder softly out, background soft
		cam.dof_blur_near_enabled = true
		cam.dof_blur_near_distance = 1.50
		cam.dof_blur_near_transition = 1.30
		cam.dof_blur_far_enabled = true
		cam.dof_blur_far_distance = 9.5
		cam.dof_blur_far_transition = 14.0
		cam.dof_blur_amount = 0.16


func _shape_clouds() -> void:
	## ProceduralSkyMaterial ADDS sky_cover on top of the gradient, BEFORE the
	## energy multiplier. Any non-trivial cover value therefore adds a flat white
	## veil that strips every last bit of blue out of the sky — measured at
	## saturation 0.02 on the round-5 capture. Ramping the noise did not save it;
	## the cover is simply disabled and the gradient does the work.
	var sky: ProceduralSkyMaterial = _sky_material()
	if sky == null:
		return
	sky.sky_cover = null
	sky.sky_cover_modulate = Color(1, 1, 1, 0)


func _tune_shadows(l: DirectionalLight3D, bias: float, normal_bias: float, opacity: float) -> void:
	# Acne control for a very low sun raking a large flat plane. The project
	# ships an 8192 directional atlas; with 4 PSSM splits cascade 0 lands around
	# 2 mm/texel at these distances, so bias can stay small enough to avoid
	# peter-panning while still killing self-shadow stripes.
	l.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS
	l.directional_shadow_split_1 = 0.045
	l.directional_shadow_split_2 = 0.13
	l.directional_shadow_split_3 = 0.34
	l.directional_shadow_blend_splits = true
	l.directional_shadow_max_distance = 130.0
	l.directional_shadow_fade_start = 0.85
	l.directional_shadow_pancake_size = 24.0
	l.shadow_bias = bias
	l.shadow_normal_bias = normal_bias
	l.shadow_blur = 1.0
	l.shadow_opacity = opacity
	l.shadow_transmittance_bias = 0.05


func _aim(l: DirectionalLight3D, elevation_deg: float, azimuth_deg: float) -> void:
	## elevation = degrees above the horizon the light sits at (never >35 per
	## ART_BIBLE 3). azimuth = yaw of the light's travel direction; 0 means it
	## travels toward -Z (sun behind camera), 180 means it travels toward +Z
	## (sun in front of the subject = backlight).
	var e: float = clampf(elevation_deg, 2.0, 35.0)
	l.rotation_degrees = Vector3(-e, azimuth_deg, 0.0)


# ---------------------------------------------------------------------------
# node / resource access
# ---------------------------------------------------------------------------

func _env() -> Environment:
	var we := get_node_or_null(^"WorldEnvironment") as WorldEnvironment
	return null if we == null else we.environment


func _camera_attributes() -> CameraAttributesPractical:
	var we := get_node_or_null(^"WorldEnvironment") as WorldEnvironment
	if we == null:
		return null
	return we.camera_attributes as CameraAttributesPractical


func _sky_material() -> ProceduralSkyMaterial:
	var env: Environment = _env()
	if env == null or env.sky == null:
		return null
	return env.sky.sky_material as ProceduralSkyMaterial


func _sun() -> DirectionalLight3D:
	return get_node(^"Sun") as DirectionalLight3D


func _rim() -> DirectionalLight3D:
	return get_node(^"Rim") as DirectionalLight3D


func _fill() -> DirectionalLight3D:
	return get_node(^"Fill") as DirectionalLight3D


func _grade_material() -> ShaderMaterial:
	var r := get_node_or_null(^"Post/Grade") as ColorRect
	return null if r == null else r.material as ShaderMaterial


static func _srgb(hex: String) -> Color:
	## Art bible colours are quoted as sRGB hex; the renderer wants linear.
	return Color(hex).srgb_to_linear()
