extends Node3D
## Neutral lighting testbed for the world rig.
##
## Nothing here is level art — it exists so the lighting, atmosphere and grade
## can be judged with no texture work to hide behind. Built entirely from
## primitives + procedural noise so it is deterministic and asset-free.
##
## Depth planes (hero faces -Z, camera rides the right shoulder at +X/+Z):
##   0.7 m   near occluder beam intruding from the top-left edge
##   1.4 m   hero capsule (1.8 m) on the left third
##   5-9 m   combat plane: two enemy proxies + a metal blade for SSR
##   12 m    mid marker: broken pillar, wall, ramp, brazier
##   26-40 m ruin cluster
##   60 m    far marker: tower + arch silhouettes
##   150 m+  ridge line, only readable as fog value

const GROUND_ALBEDO := "#5C564D"
const STONE_ALBEDO := "#6E6860"
const DARK_ALBEDO := "#332F2C"

var _rng := RandomNumberGenerator.new()


func _ready() -> void:
	_rng.seed = 20260731
	_build_ground()
	_build_hero()
	_build_near_occluder()
	_build_combat_plane()
	_build_mid_marker()
	_build_ruins()
	_build_far_marker()
	_build_ridge()
	_scatter_debris()
	_build_air()


# ---------------------------------------------------------------------------
# procedural materials
# ---------------------------------------------------------------------------

func _noise(freq: float, seed_v: int, octaves: int = 5) -> FastNoiseLite:
	var n := FastNoiseLite.new()
	n.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	n.seed = seed_v
	n.frequency = freq
	n.fractal_type = FastNoiseLite.FRACTAL_FBM
	n.fractal_octaves = octaves
	n.fractal_lacunarity = 2.1
	n.fractal_gain = 0.5
	return n


func _ramp(lo: float, hi: float) -> Gradient:
	var g := Gradient.new()
	g.set_color(0, Color(lo, lo, lo, 1.0))
	g.set_color(1, Color(hi, hi, hi, 1.0))
	return g


func _ramp_pts(offs: PackedFloat32Array, vals: PackedFloat32Array) -> Gradient:
	var g := Gradient.new()
	var cols := PackedColorArray()
	for v in vals:
		cols.append(Color(v, v, v, 1.0))
	g.offsets = offs
	g.colors = cols
	return g


func _rough_tex(seed_v: int, lo: float, hi: float) -> NoiseTexture2D:
	var t := NoiseTexture2D.new()
	t.width = 512
	t.height = 512
	t.seamless = true
	t.seamless_blend_skirt = 0.2
	t.noise = _noise(0.012, seed_v, 6)
	t.color_ramp = _ramp(lo, hi)
	return t


func _normal_tex(seed_v: int, strength: float) -> NoiseTexture2D:
	var t := NoiseTexture2D.new()
	t.width = 512
	t.height = 512
	t.seamless = true
	t.seamless_blend_skirt = 0.2
	t.as_normal_map = true
	t.bump_strength = strength
	t.noise = _noise(0.03, seed_v + 7331, 5)
	return t


## ART_BIBLE 7: roughness is never a constant, albedo never pure black/white.
## `uv` is triplanar tiles-per-metre (world space), NOT a UV repeat count.
func _surface(hex: String, rough_lo: float, rough_hi: float, seed_v: int,
		uv: float, bump: float = 5.0) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(hex)
	m.roughness = 1.0
	m.roughness_texture = _rough_tex(seed_v, rough_lo, rough_hi)
	m.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_GRAYSCALE
	m.normal_enabled = true
	m.normal_texture = _normal_tex(seed_v, bump)
	m.normal_scale = 1.0
	m.uv1_scale = Vector3(uv, uv, 1.0)
	m.uv1_triplanar = true
	m.uv1_triplanar_sharpness = 1.2
	m.metallic = 0.0
	m.metallic_specular = 0.5
	m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
	return m


func _metal(hex: String, rough: float) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(hex)
	m.metallic = 1.0
	m.metallic_specular = 0.5
	m.roughness = 1.0
	m.roughness_texture = _rough_tex(4242, rough - 0.12, rough + 0.12)
	m.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_GRAYSCALE
	m.normal_enabled = true
	m.normal_texture = _normal_tex(4242, 2.5)
	m.uv1_scale = Vector3(2.5, 2.5, 1.0)
	m.uv1_triplanar = true
	return m


func _ember_material(hex: String, energy: float) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(hex).darkened(0.6)
	m.roughness = 0.75
	m.emission_enabled = true
	m.emission = Color(hex)
	m.emission_energy_multiplier = energy
	return m


# ---------------------------------------------------------------------------
# spawn helpers
# ---------------------------------------------------------------------------

func _add(nm: String, mesh: Mesh, mat: Material, xf: Transform3D) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	mi.name = nm
	mi.mesh = mesh
	mi.material_override = mat
	mi.transform = xf
	mi.gi_mode = GeometryInstance3D.GI_MODE_STATIC
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	add_child(mi)
	return mi


func _box(sz: Vector3) -> BoxMesh:
	var b := BoxMesh.new()
	b.size = sz
	b.subdivide_width = 2
	b.subdivide_height = 2
	b.subdivide_depth = 2
	return b


func _cyl(r_top: float, r_bot: float, h: float) -> CylinderMesh:
	var c := CylinderMesh.new()
	c.top_radius = r_top
	c.bottom_radius = r_bot
	c.height = h
	c.radial_segments = 24
	c.rings = 3
	return c


func _xf(pos: Vector3, rot_deg: Vector3 = Vector3.ZERO) -> Transform3D:
	var b := Basis.from_euler(Vector3(deg_to_rad(rot_deg.x), deg_to_rad(rot_deg.y), deg_to_rad(rot_deg.z)))
	return Transform3D(b, pos)


# ---------------------------------------------------------------------------
# depth planes
# ---------------------------------------------------------------------------

func _build_ground() -> void:
	var p := PlaneMesh.new()
	p.size = Vector2(600.0, 600.0)
	p.subdivide_width = 60
	p.subdivide_depth = 60
	# Wetness lives in the ground's own roughness map rather than in separate
	# puddle decals: no hard rectangle edges, and SSR still gets real patches of
	# low roughness to reflect into (ART_BIBLE 7 "wet stone"). The ramp is
	# heavily biased toward rough — a linear 0.16-0.94 ramp turns the whole
	# ground into an ice rink.
	var m := _surface(GROUND_ALBEDO, 0.5, 0.9, 11, 0.22, 7.0)
	var wet_ramp := _ramp_pts(
		PackedFloat32Array([0.0, 0.50, 0.74, 0.88, 1.0]),
		PackedFloat32Array([0.94, 0.86, 0.72, 0.40, 0.26]))
	var rt := m.roughness_texture as NoiseTexture2D
	rt.color_ramp = wet_ramp
	rt.noise = _noise(0.006, 11, 5)
	m.metallic_specular = 0.62
	_add("Ground", p, m, _xf(Vector3.ZERO))


func _build_hero() -> void:
	# 1.8 m capsule stand-in, on the left third of frame.
	var hero := Node3D.new()
	hero.name = "Hero"
	add_child(hero)

	var body := CapsuleMesh.new()
	body.radius = 0.42
	body.height = 1.80
	body.radial_segments = 32
	body.rings = 12
	var skin := _surface("#4E4238", 0.40, 0.70, 21, 1.6, 3.0)
	var mi := MeshInstance3D.new()
	mi.name = "Body"
	mi.mesh = body
	mi.material_override = skin
	mi.transform = _xf(Vector3(0.0, 0.90, 0.0))
	mi.gi_mode = GeometryInstance3D.GI_MODE_STATIC
	hero.add_child(mi)

	# near pauldron: the over-the-shoulder occluder that sells the rig. Squashed
	# hard along the body axis so it silhouettes as armour plate, not a ball.
	var pl := SphereMesh.new()
	pl.radius = 0.30
	pl.height = 0.60
	pl.radial_segments = 20
	pl.rings = 8
	var leather := _surface("#3A2E24", 0.52, 0.80, 33, 2.4, 4.0)
	var pm := MeshInstance3D.new()
	pm.name = "Pauldron"
	pm.mesh = pl
	pm.material_override = leather
	pm.transform = Transform3D(
		Basis.from_euler(Vector3(deg_to_rad(-8.0), 0.0, deg_to_rad(-26.0)))
			.scaled(Vector3(1.05, 0.62, 0.86)),
		Vector3(0.30, 1.36, 0.05))
	pm.gi_mode = GeometryInstance3D.GI_MODE_STATIC
	hero.add_child(pm)

	# a second, lower shoulder/arm mass so the near silhouette is not one sphere
	var arm := _cyl(0.15, 0.19, 0.62)
	var am := MeshInstance3D.new()
	am.name = "Arm"
	am.mesh = arm
	am.material_override = leather
	am.transform = _xf(Vector3(0.40, 1.02, 0.10), Vector3(4, 0, -12))
	am.gi_mode = GeometryInstance3D.GI_MODE_STATIC
	hero.add_child(am)

	# axe haft running diagonally out of frame (ART_BIBLE 2: diagonals)
	var haft := _cyl(0.035, 0.045, 1.25)
	var hm := MeshInstance3D.new()
	hm.name = "Haft"
	hm.mesh = haft
	hm.material_override = _surface("#3B2B20", 0.45, 0.72, 55, 3.0, 3.0)
	hm.transform = _xf(Vector3(0.28, 0.95, 0.36), Vector3(-58, 6, 24))
	hm.gi_mode = GeometryInstance3D.GI_MODE_STATIC
	hero.add_child(hm)


func _build_near_occluder() -> void:
	# ART_BIBLE 2: the ref plates almost always have a dark, out-of-focus beam or
	# branch intruding from a frame edge. Solved against the look_cold framing so
	# it crosses the top-left corner at 0.6-1.4 m — inside the near-DOF band.
	var dark := _surface("#1C1815", 0.55, 0.90, 77, 2.0, 5.0)
	var beam_basis := Basis(
		Vector3(0.83839, 0.0, 0.54507),
		Vector3(-0.31623, 0.81450, 0.48640),
		Vector3(-0.44396, -0.58016, 0.68287))
	_add("NearBeam", _box(Vector3(0.17, 0.15, 2.9)), dark,
		Transform3D(beam_basis, Vector3(0.2135, 2.0767, 0.5663)))
	_add("NearBeamKnot", _box(Vector3(0.24, 0.22, 0.30)), dark,
		Transform3D(beam_basis.rotated(Vector3(0, 1, 0), 0.5), Vector3(0.10, 2.03, 0.72)))
	var rope := _cyl(0.022, 0.022, 0.9)
	_add("NearRope", rope, _surface("#2C241B", 0.6, 0.9, 78, 4.0, 6.0),
		_xf(Vector3(-0.02, 1.62, 0.86), Vector3(9, 0, 6)))


func _build_combat_plane() -> void:
	# enemy proxies, tack sharp, 5-9 m
	var e0 := CapsuleMesh.new()
	e0.radius = 0.30
	e0.height = 1.72
	e0.radial_segments = 24
	e0.rings = 8
	var flesh := _surface("#453E36", 0.36, 0.68, 91, 1.8, 3.5)
	_add("Enemy0", e0, flesh, _xf(Vector3(2.55, 0.86, -5.40)))

	var e1 := CapsuleMesh.new()
	e1.radius = 0.33
	e1.height = 1.90
	e1.radial_segments = 24
	e1.rings = 8
	_add("Enemy1", e1, flesh, _xf(Vector3(4.55, 0.95, -8.20)))

	# glowing eyes so the fog/glow chain has an emissive at combat range
	var eye := SphereMesh.new()
	eye.radius = 0.045
	eye.height = 0.09
	var eyemat := _ember_material("#FFB05A", 9.0)
	_add("Eye0", eye, eyemat, _xf(Vector3(2.44, 1.52, -5.14)))
	_add("Eye1", eye, eyemat, _xf(Vector3(2.66, 1.52, -5.14)))

	# steel blade — metallic 1, gives SSR something specular to catch
	var blade := _box(Vector3(0.06, 0.92, 0.17))
	_add("Blade", blade, _metal("#B8BCC4", 0.30), _xf(Vector3(3.15, 0.95, -5.05), Vector3(0, -22, 34)))

	# a diagonal spear stuck in the ground
	_add("Spear", _cyl(0.03, 0.045, 2.6), _surface("#4A3A2A", 0.5, 0.8, 92, 3.0, 3.0),
		_xf(Vector3(-1.9, 1.05, -7.4), Vector3(24, 12, -31)))

	# ART_BIBLE 12.9: a bare floor spanning a third of the frame is an instant
	# fail. These break up the open right-hand ground at 6-11 m.
	var dark := _surface(DARK_ALBEDO, 0.5, 0.88, 93, 0.7, 6.0)
	var stone := _surface(STONE_ALBEDO, 0.46, 0.88, 94, 0.7, 6.0)
	_add("R_Wall", _box(Vector3(3.4, 1.15, 0.55)), stone, _xf(Vector3(7.4, 0.57, -7.6), Vector3(0, -34, 1)))
	_add("R_WallCap", _box(Vector3(1.1, 0.9, 0.6)), stone, _xf(Vector3(6.1, 1.35, -7.0), Vector3(0, -34, -6)))
	_add("R_Crate", _box(Vector3(0.85, 0.85, 0.85)), dark, _xf(Vector3(4.9, 0.42, -5.6), Vector3(0, 21, 0)))
	_add("R_Plank", _box(Vector3(0.22, 0.16, 3.6)), dark, _xf(Vector3(5.6, 0.66, -6.6), Vector3(-11, 63, 26)))
	_add("R_Block", _box(Vector3(1.5, 0.7, 1.2)), stone, _xf(Vector3(3.6, 0.35, -3.9), Vector3(2, 41, -3)))
	_add("R_Post", _cyl(0.17, 0.22, 2.3), dark, _xf(Vector3(9.6, 1.15, -10.4), Vector3(0, 0, 5)))
	_add("R_Slab", _box(Vector3(2.2, 0.35, 1.6)), stone, _xf(Vector3(8.9, 0.18, -6.2), Vector3(-4, 12, 2)))


func _build_mid_marker() -> void:
	# --- the 12 m marker cluster -------------------------------------------
	var stone := _surface(STONE_ALBEDO, 0.44, 0.86, 41, 0.55, 6.0)
	var dark := _surface(DARK_ALBEDO, 0.5, 0.88, 42, 0.55, 6.0)

	_add("Mid_Pillar", _cyl(0.48, 0.62, 4.30), stone, _xf(Vector3(3.30, 2.15, -12.0), Vector3(0, 0, -2.5)))
	_add("Mid_PillarCap", _box(Vector3(1.5, 0.34, 1.5)), stone, _xf(Vector3(3.28, 4.42, -12.0), Vector3(0, 14, -2.5)))
	_add("Mid_Wall", _box(Vector3(5.4, 1.85, 0.7)), stone, _xf(Vector3(-2.90, 0.92, -12.4), Vector3(0, -9, 0)))
	_add("Mid_WallBroken", _box(Vector3(1.6, 2.9, 0.7)), stone, _xf(Vector3(-5.7, 1.45, -12.9), Vector3(0, -9, 3)))
	_add("Mid_Ramp", _box(Vector3(3.2, 0.28, 5.0)), dark, _xf(Vector3(0.4, 1.05, -12.6), Vector3(-22, 8, 0)))
	_add("Mid_Beam", _box(Vector3(0.30, 0.30, 6.2)), dark, _xf(Vector3(1.4, 2.45, -11.2), Vector3(-34, 26, 12)))
	_add("Mid_Crate", _box(Vector3(1.0, 1.0, 1.0)), dark, _xf(Vector3(5.1, 0.5, -10.4), Vector3(0, 27, 0)))
	_add("Mid_Crate2", _box(Vector3(0.9, 0.9, 0.9)), dark, _xf(Vector3(5.4, 1.4, -10.6), Vector3(0, -12, 4)))

	# brazier at the mid plane: emissive + a real light, so glow and the warm
	# pool both read. Works as a fire in ember and as a lit doorway in overcast.
	_brazier(Vector3(-1.35, 0.55, -11.6), 1.0)
	_brazier(Vector3(6.60, 0.55, -14.2), 0.8)


func _brazier(pos: Vector3, scale: float) -> void:
	var bowl := _cyl(0.34 * scale, 0.20 * scale, 0.40 * scale)
	_add("Brazier_%d" % get_child_count(), bowl,
		_surface("#2E2A26", 0.4, 0.7, 63, 2.0, 4.0), _xf(pos))
	var coal := SphereMesh.new()
	coal.radius = 0.26 * scale
	coal.height = 0.30 * scale
	_add("Coals_%d" % get_child_count(), coal, _ember_material("#FF7A22", 7.5),
		_xf(pos + Vector3(0, 0.20 * scale, 0)))
	var l := OmniLight3D.new()
	l.name = "BrazierLight_%d" % get_child_count()
	l.position = pos + Vector3(0, 0.42 * scale, 0)
	l.light_color = Color("#FF8A3A")
	l.light_energy = 7.0 * scale
	l.omni_range = 8.0 * scale
	l.omni_attenuation = 2.0
	l.light_volumetric_fog_energy = 2.0
	l.shadow_enabled = true
	l.shadow_bias = 0.04
	l.shadow_normal_bias = 1.2
	add_child(l)


func _build_ruins() -> void:
	# 22-42 m — keeps the middle distance from going empty
	var stone := _surface(STONE_ALBEDO, 0.46, 0.88, 43, 0.40, 6.0)
	var dark := _surface(DARK_ALBEDO, 0.5, 0.88, 44, 0.40, 6.0)
	_add("Ruin_A", _box(Vector3(6.0, 5.5, 4.0)), stone, _xf(Vector3(-11.0, 2.75, -24.0), Vector3(0, 17, 0)))
	_add("Ruin_B", _cyl(0.7, 0.95, 7.4), stone, _xf(Vector3(9.5, 3.7, -26.5), Vector3(0, 0, 3)))
	_add("Ruin_C", _box(Vector3(9.0, 3.0, 3.0)), dark, _xf(Vector3(-4.0, 1.5, -33.0), Vector3(0, -8, 0)))
	_add("Ruin_D", _box(Vector3(0.5, 0.5, 12.0)), dark, _xf(Vector3(2.0, 6.4, -28.0), Vector3(-18, 40, 9)))
	_add("Ruin_E", _cyl(0.55, 0.8, 6.0), stone, _xf(Vector3(15.5, 3.0, -34.0)))
	_add("Ruin_F", _box(Vector3(5.0, 8.0, 5.0)), stone, _xf(Vector3(-19.0, 4.0, -40.0), Vector3(0, 33, 0)))


func _build_far_marker() -> void:
	# --- the 60 m marker: read as silhouette + fog only --------------------
	var stone := _surface(STONE_ALBEDO, 0.5, 0.9, 45, 0.28, 6.0)
	_add("Far_Tower", _box(Vector3(7.0, 17.0, 7.0)), stone, _xf(Vector3(-13.0, 8.5, -60.0), Vector3(0, 12, 0)))
	_add("Far_TowerTop", _box(Vector3(9.0, 1.4, 9.0)), stone, _xf(Vector3(-13.0, 17.6, -60.0), Vector3(0, 12, 0)))
	_add("Far_Arch_L", _box(Vector3(2.6, 12.0, 2.6)), stone, _xf(Vector3(6.0, 6.0, -60.0)))
	_add("Far_Arch_R", _box(Vector3(2.6, 12.0, 2.6)), stone, _xf(Vector3(15.0, 6.0, -60.0)))
	_add("Far_Arch_Top", _box(Vector3(11.6, 2.2, 2.6)), stone, _xf(Vector3(10.5, 13.1, -60.0)))
	_add("Far_Rock", _cyl(3.0, 7.0, 13.0), stone, _xf(Vector3(27.0, 6.5, -62.0), Vector3(0, 20, -4)))
	_add("Far_Mast", _cyl(0.25, 0.4, 20.0), stone, _xf(Vector3(-2.0, 10.0, -66.0), Vector3(0, 0, 7)))


func _build_ridge() -> void:
	# 140-240 m — pure fog value, gives the frame an actual horizon
	# Sheared, overlapping wedges rather than clean cones — a symmetric cone at
	# 180 m reads as a party hat no matter how much fog is in front of it.
	var stone := _surface(STONE_ALBEDO, 0.6, 0.95, 46, 0.08, 4.0)
	var specs := [
		[Vector3(-120.0, 22.0, -168.0), Vector3(1.5, 1.0, 0.8), 55.0, 18.0, -9.0],
		[Vector3(-64.0, 30.0, -196.0), Vector3(1.1, 1.35, 1.0), 70.0, -24.0, 7.0],
		[Vector3(-6.0, 26.0, -232.0), Vector3(1.8, 1.05, 1.2), 62.0, 12.0, -5.0],
		[Vector3(58.0, 34.0, -178.0), Vector3(1.0, 1.5, 0.9), 68.0, 44.0, 8.0],
		[Vector3(126.0, 24.0, -212.0), Vector3(1.6, 1.0, 1.1), 58.0, -8.0, -6.0],
		[Vector3(196.0, 30.0, -190.0), Vector3(1.2, 1.25, 1.0), 64.0, 26.0, 5.0],
	]
	for i in specs.size():
		var pos: Vector3 = specs[i][0]
		var scl: Vector3 = specs[i][1]
		var h: float = specs[i][2]
		var b := Basis.from_euler(Vector3(0.0, deg_to_rad(specs[i][3]), deg_to_rad(specs[i][4]))).scaled(scl)
		var mi := MeshInstance3D.new()
		mi.name = "Ridge_%d" % i
		mi.mesh = _cyl(h * 0.14, h * 0.62, h)
		mi.material_override = stone
		mi.transform = Transform3D(b, pos)
		mi.gi_mode = GeometryInstance3D.GI_MODE_DISABLED
		add_child(mi)


func _scatter_debris() -> void:
	# ART_BIBLE 12.6: an empty untextured floor is an instant fail. Deterministic
	# scatter of rubble across the whole readable depth range.
	var rock := _surface("#5E574E", 0.5, 0.9, 51, 1.4, 6.0)
	var rock2 := _surface("#4C463E", 0.45, 0.88, 52, 1.4, 6.0)
	var meshes: Array[Mesh] = [
		_box(Vector3(0.30, 0.20, 0.26)),
		_box(Vector3(0.17, 0.14, 0.21)),
		_cyl(0.08, 0.13, 0.24),
		_box(Vector3(0.42, 0.12, 0.31)),
	]
	var parent := Node3D.new()
	parent.name = "Debris"
	add_child(parent)

	for i in 460:
		var ang := _rng.randf_range(0.0, TAU)
		var rad := sqrt(_rng.randf()) * 46.0
		var p := Vector3(sin(ang) * rad, 0.0, -abs(cos(ang) * rad) - 1.2)
		if p.length() < 1.1:
			continue
		var s := _rng.randf_range(0.45, 1.6)
		var m: Mesh = meshes[_rng.randi_range(0, meshes.size() - 1)]
		var mi := MeshInstance3D.new()
		mi.mesh = m
		mi.material_override = rock if (i % 2 == 0) else rock2
		var b := Basis.from_euler(Vector3(
			_rng.randf_range(-0.25, 0.25),
			_rng.randf_range(0.0, TAU),
			_rng.randf_range(-0.25, 0.25))).scaled(Vector3(s, s * 0.8, s))
		mi.transform = Transform3D(b, p + Vector3(0, 0.05 * s, 0))
		mi.gi_mode = GeometryInstance3D.GI_MODE_STATIC
		parent.add_child(mi)

	# a few larger rocks to break the ground silhouette — kept chunky rather than
	# flat-topped, a wide flat box at 5 m reads as a table, not as rubble
	for i in 18:
		var ang := _rng.randf_range(-1.5, 1.5)
		var rad := _rng.randf_range(6.0, 26.0)
		var p := Vector3(sin(ang) * rad, 0.0, -cos(ang) * rad)
		var s := _rng.randf_range(0.9, 1.9)
		var mi := MeshInstance3D.new()
		mi.mesh = _box(Vector3(0.85, 0.75, 0.8))
		mi.material_override = rock
		var b := Basis.from_euler(Vector3(
			_rng.randf_range(-0.20, 0.20),
			_rng.randf_range(0.0, TAU),
			_rng.randf_range(-0.20, 0.20))).scaled(Vector3(s, s * 0.95, s * 0.9))
		mi.transform = Transform3D(b, p + Vector3(0, 0.22 * s, 0))
		mi.gi_mode = GeometryInstance3D.GI_MODE_STATIC
		parent.add_child(mi)


func _build_air() -> void:
	# ART_BIBLE 12.6: empty air reads as cheap. Slow drifting motes, unshaded so
	# they stay bright when back-lit — the way real backlit dust behaves.
	var grad := Gradient.new()
	grad.set_color(0, Color(1, 1, 1, 1))
	grad.set_color(1, Color(1, 1, 1, 0))
	grad.offsets = PackedFloat32Array([0.0, 1.0])
	var dot := GradientTexture2D.new()
	dot.gradient = grad
	dot.width = 64
	dot.height = 64
	dot.fill = GradientTexture2D.FILL_RADIAL
	dot.fill_from = Vector2(0.5, 0.5)
	dot.fill_to = Vector2(1.0, 0.5)

	var quad := QuadMesh.new()
	quad.size = Vector2(1.0, 1.0)

	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	mat.albedo_texture = dot
	mat.albedo_color = Color(1.0, 0.93, 0.82, 0.5)
	mat.billboard_mode = BaseMaterial3D.BILLBOARD_ENABLED
	mat.billboard_keep_scale = true
	mat.disable_receive_shadows = true
	mat.vertex_color_use_as_albedo = true
	quad.material = mat

	var proc := ParticleProcessMaterial.new()
	proc.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_BOX
	proc.emission_box_extents = Vector3(11.0, 4.5, 11.0)
	proc.direction = Vector3(0.25, -1.0, 0.1)
	proc.spread = 32.0
	proc.initial_velocity_min = 0.10
	proc.initial_velocity_max = 0.42
	proc.gravity = Vector3(0.06, -0.05, 0.02)
	proc.scale_min = 0.022
	proc.scale_max = 0.085
	proc.turbulence_enabled = true
	proc.turbulence_noise_strength = 0.22
	proc.turbulence_noise_scale = 2.2
	proc.color = Color(1.0, 0.95, 0.86, 0.85)

	var p := GPUParticles3D.new()
	p.name = "AirMotes"
	p.position = Vector3(1.0, 3.2, -7.0)
	p.amount = 900
	p.lifetime = 18.0
	p.preprocess = 16.0
	p.explosiveness = 0.0
	p.randomness = 0.9
	p.fixed_fps = 30
	p.interpolate = true
	p.draw_pass_1 = quad
	p.process_material = proc
	p.visibility_aabb = AABB(Vector3(-26.0, -8.0, -30.0), Vector3(52.0, 22.0, 60.0))
	add_child(p)
