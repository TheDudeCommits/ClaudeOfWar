@tool
extends Node3D
## PLACEHOLDER atmosphere for the arena.
##
## `res://scenes/world/world.tscn` is owned by another agent and is the real
## home for the render/lighting stack. Until it exists (or if it is missing at
## runtime) the arena instances this instead so the environment art can be
## judged at all. It implements both ART_BIBLE section 3 recipes behind
## `apply_time_of_day()`, which is the contract the capture rig calls.

@onready var _env: WorldEnvironment = $WorldEnvironment
@onready var _sun: DirectionalLight3D = $Sun
@onready var _fill: DirectionalLight3D = $Fill

var _tod := "cold_overcast"


func _ready() -> void:
	apply_time_of_day(_tod)


func apply_time_of_day(tod: String) -> void:
	_tod = tod
	if _env == null:
		_env = get_node_or_null("WorldEnvironment") as WorldEnvironment
		_sun = get_node_or_null("Sun") as DirectionalLight3D
		_fill = get_node_or_null("Fill") as DirectionalLight3D
	if _env == null or _env.environment == null:
		return
	var e: Environment = _env.environment
	var sky_mat: ProceduralSkyMaterial = null
	if e.sky != null:
		sky_mat = e.sky.sky_material as ProceduralSkyMaterial

	match tod:
		"ember_hellscape", "ember":
			_sun.light_color = Color(1.0, 0.262, 0.042)
			_sun.light_energy = 3.1
			_sun.rotation_degrees = Vector3(-14.0, 152.0, 0.0)
			_sun.light_angular_distance = 1.2
			_fill.light_color = Color(0.194, 0.047, 0.275)
			_fill.light_energy = 0.9
			e.ambient_light_color = Color(0.16, 0.06, 0.10)
			e.ambient_light_energy = 0.85
			e.fog_light_color = Color(0.34, 0.13, 0.09)
			e.fog_density = 0.030
			e.volumetric_fog_density = 0.075
			e.volumetric_fog_albedo = Color(0.62, 0.36, 0.24)
			e.volumetric_fog_emission = Color(0.09, 0.025, 0.012)
			e.adjustment_saturation = 0.94
			if sky_mat != null:
				sky_mat.sky_top_color = Color(0.055, 0.030, 0.055)
				sky_mat.sky_horizon_color = Color(0.42, 0.13, 0.05)
				sky_mat.ground_horizon_color = Color(0.20, 0.07, 0.04)
				sky_mat.ground_bottom_color = Color(0.03, 0.015, 0.02)
		_:
			# 3a "Cold Overcast Ruin" - the arena's default.
			# Ambient carries most of the level; the sun is a raking accent that
			# rims silhouettes. A sun-dominant balance turns the whole snowfield
			# amber, which is the opposite of the reference plate.
			_sun.light_color = Color(1.0, 0.85, 0.68)
			_sun.light_energy = 2.7
			_sun.rotation_degrees = Vector3(-19.0, 138.0, 0.0)
			_sun.light_angular_distance = 0.85
			_fill.light_color = Color(0.115, 0.175, 0.27)
			_fill.light_energy = 0.85
			e.ambient_light_color = Color(0.115, 0.175, 0.27)
			e.ambient_light_energy = 1.6
			e.fog_light_color = Color(0.338, 0.434, 0.553)
			e.fog_density = 0.008
			e.volumetric_fog_density = 0.013
			e.volumetric_fog_albedo = Color(0.80, 0.86, 0.95)
			e.volumetric_fog_emission = Color(0.0, 0.0, 0.0)
			e.adjustment_saturation = 0.86
			if sky_mat != null:
				sky_mat.sky_top_color = Color(0.048, 0.125, 0.296)
				sky_mat.sky_horizon_color = Color(0.275, 0.371, 0.480)
				sky_mat.ground_horizon_color = Color(0.16, 0.20, 0.25)
				sky_mat.ground_bottom_color = Color(0.05, 0.06, 0.075)
