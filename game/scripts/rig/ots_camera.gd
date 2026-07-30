extends Node3D
class_name OTSCamera
## Over-the-shoulder combat camera.
##
## Framing is the strongest single cue that separates a AAA action game from a
## hobby project: the reference plates put the camera roughly two metres behind
## the hero's right shoulder at chest height with a wide-ish lens, so the hero
## eats a third of the frame. A polite, far-back, level "third person camera"
## loses the blind test before lighting is even considered. See ART_BIBLE §1.

@export var target: Node3D
@export var shoulder := Vector3(0.62, 1.46, 0.0)  ## right/up offset from actor origin
@export var distance := 2.15
@export var fov_base := 56.0
@export var pitch_deg := -7.0
@export var yaw_deg := 0.0
@export var collision_mask := 1

## Lock-on biases framing so the hero stays left-of-centre and the target sits in
## the right two thirds, matching how the reference plates compose a duel.
@export var lockon_target: Node3D
@export var lockon_hero_bias := 0.68

@export_group("Feel")
@export var follow_lag := 12.0
@export var aim_lag := 9.0
@export var trauma_decay := 1.9
@export var max_shake_pos := 0.085
@export var max_shake_rot := 2.1

var _trauma := 0.0
var _fov_punch := 0.0
var _roll := 0.0
var _pos := Vector3.ZERO
var _aim := Vector3.ZERO
var _seed := 0.0
var _arm: SpringArm3D
var _cam: Camera3D
var _initialised := false


func _ready() -> void:
	_seed = randf() * 1000.0
	_arm = SpringArm3D.new()
	_arm.spring_length = distance
	_arm.margin = 0.28
	_arm.collision_mask = collision_mask
	add_child(_arm)

	_cam = Camera3D.new()
	_cam.fov = fov_base
	_cam.near = 0.05
	_cam.far = 800.0
	_cam.current = true
	_arm.add_child(_cam)
	_cam.position = Vector3.ZERO

	# A shot-spec capture drives the camera directly; don't fight it.
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--shot="):
			set_physics_process(false)
			return


func camera() -> Camera3D:
	return _cam


func _physics_process(delta: float) -> void:
	if target == null:
		return
	var anchor := target.global_position + \
		target.global_transform.basis.x * shoulder.x + Vector3.UP * shoulder.y

	var want_aim := anchor
	if lockon_target != null:
		# Compose hero and target, weighted toward the hero so the enemy reads in
		# the right of frame rather than both actors sitting dead centre.
		want_aim = anchor.lerp(lockon_target.global_position + Vector3.UP * 1.1,
			1.0 - lockon_hero_bias)

	if not _initialised:
		_pos = anchor
		_aim = want_aim
		_initialised = true
	else:
		_pos = _pos.lerp(anchor, 1.0 - exp(-follow_lag * delta))
		_aim = _aim.lerp(want_aim, 1.0 - exp(-aim_lag * delta))

	var yaw := deg_to_rad(yaw_deg)
	if lockon_target != null:
		var flat := lockon_target.global_position - _pos
		flat.y = 0.0
		if flat.length_squared() > 0.01:
			yaw = atan2(flat.x, flat.z) + PI

	global_position = _pos
	var basis := Basis.from_euler(Vector3(deg_to_rad(pitch_deg), yaw, 0.0))
	global_transform.basis = basis

	# Shake: trauma-squared so small hits stay subtle and big ones bite.
	_trauma = maxf(0.0, _trauma - trauma_decay * delta)
	var s := _trauma * _trauma
	var t := Time.get_ticks_msec() / 1000.0 * 22.0 + _seed
	if s > 0.0001:
		_cam.position = Vector3(
			(sin(t * 1.31) + sin(t * 2.7)) * 0.5 * max_shake_pos * s,
			(sin(t * 1.77) + sin(t * 3.1)) * 0.5 * max_shake_pos * s,
			0.0)
		_roll = sin(t * 1.13) * max_shake_rot * s
	else:
		_cam.position = _cam.position.lerp(Vector3.ZERO, 0.35)
		_roll = lerpf(_roll, 0.0, 0.35)

	_fov_punch = lerpf(_fov_punch, 0.0, 1.0 - exp(-9.0 * delta))
	_cam.fov = fov_base + _fov_punch
	_cam.rotation.z = deg_to_rad(_roll)
	_arm.spring_length = distance


## Called by the combat system on a landed hit. `amount` 0..1.
func impact(amount: float, fov_dip := -4.5) -> void:
	_trauma = clampf(_trauma + amount, 0.0, 1.0)
	_fov_punch = minf(_fov_punch, fov_dip * amount)
