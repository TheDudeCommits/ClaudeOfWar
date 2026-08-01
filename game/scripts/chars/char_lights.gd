extends Node3D
## Per-character light rig.
##
## Separate from whatever `world.tscn` does, and always present. Environment
## lighting is authored for a level; a character needs its own modelling key and
## its own back rim, and ART_BIBLE §3 is explicit that rim separation is not
## optional ("Always a rim/back light separating hero from background. Always.").
## The first capture with world lighting alone produced exactly the failure that
## rule exists to prevent: a flatly front-lit figure with no edge.
##
## Every light here is unshadowed except the key, so this rig costs almost
## nothing and cannot fight the world's shadow atlas.

class Rig:
	var key: SpotLight3D
	var rim: SpotLight3D
	var kick: SpotLight3D
	var fill: OmniLight3D
	## Applied inside set_recipe(). Scaling the energies in add_subject() instead
	## silently did nothing, because set_recipe() then assigned over them.
	var gain: float = 1.0


var _rigs: Array[Rig] = []
var _tod := "cold_overcast"


func add_subject(at: Vector3, head_h: float, scale: float = 1.0) -> void:
	var r := Rig.new()
	var aim := at + Vector3(0.0, head_h, 0.0)

	# Key: high and to the camera side, 3/4 off axis. This is also what puts the
	# catchlight in the cornea shells — a dead-front key gives a highlight dead
	# centre in the pupil, which reads as a doll.
	r.key = _spot(at + Vector3(1.45, 1.15, 1.60), aim, 40.0)
	r.key.shadow_enabled = true
	r.key.shadow_bias = 0.012
	r.key.shadow_normal_bias = 0.8
	r.key.shadow_blur = 1.4
	r.key.light_size = 0.35

	# Rim: behind and above the opposite shoulder, tight and hot.
	# Kept off the camera axis: directly behind the subject the spot flares
	# straight down the lens and the rim becomes a bloom smear.
	r.rim = _spot(at + Vector3(-1.55, 1.75, -1.05), aim, 30.0)
	r.rim.light_specular = 1.8

	# Kicker on the key side but from behind, so the silhouette closes on both
	# edges rather than going dark on one side.
	r.kick = _spot(at + Vector3(1.55, 1.30, -1.45), aim, 32.0)
	r.kick.light_specular = 1.2

	r.fill = OmniLight3D.new()
	r.fill.omni_range = 5.0
	r.fill.omni_attenuation = 1.5
	r.fill.shadow_enabled = false
	r.fill.light_specular = 0.15
	r.fill.position = at + Vector3(-0.9, 1.05, 1.5)
	add_child(r.fill)

	r.gain = scale
	_rigs.append(r)
	set_recipe(_tod)


func _spot(from: Vector3, to: Vector3, angle: float) -> SpotLight3D:
	var s := SpotLight3D.new()
	s.spot_angle = angle
	s.spot_angle_attenuation = 0.9
	s.spot_range = from.distance_to(to) * 2.6
	s.spot_attenuation = 0.8
	s.shadow_enabled = false
	s.position = from
	add_child(s)
	s.look_at(to, Vector3.UP)
	return s


func set_recipe(tod: String) -> void:
	_tod = tod
	var warm := tod.begins_with("ember")
	for r in _rigs:
		if warm:
			r.key.light_color = Color(1.0, 0.60, 0.30)
			r.key.light_energy = 2.2 * r.gain
			r.rim.light_color = Color(1.0, 0.66, 0.34)
			r.rim.light_energy = 3.8 * r.gain
			r.kick.light_color = Color(1.0, 0.50, 0.24)
			r.kick.light_energy = 1.8 * r.gain
			r.fill.light_color = Color(0.478, 0.239, 0.561)
			r.fill.light_energy = 1.0 * r.gain
		else:
			# Cold overcast: warm low sun as key, sky-blue rim, cool bounce fill.
			r.key.light_color = Color(1.0, 0.886, 0.745)
			r.key.light_energy = 1.9 * r.gain
			r.rim.light_color = Color(0.78, 0.86, 1.0)
			r.rim.light_energy = 3.2 * r.gain
			r.kick.light_color = Color(0.86, 0.90, 1.0)
			r.kick.light_energy = 1.5 * r.gain
			r.fill.light_color = Color(0.42, 0.53, 0.70)
			r.fill.light_energy = 0.9 * r.gain
