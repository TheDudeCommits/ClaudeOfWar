@tool
extends Node3D
## Binds the arena's real materials onto the imported GLB meshes.
##
## The kit ships as one merged mesh per material (arena_stone.glb,
## arena_timber.glb, ...) so the binding is a name lookup rather than a set of
## brittle node paths into imported scenes. Doing it here also means a material
## tweak never requires re-exporting geometry from Blender.

const MAT_DIR := "res://assets/arena/materials/"
const KEYS: PackedStringArray = [
	"ground", "stone", "timber", "plank", "iron", "cloth", "snow",
	"rope", "thatch", "bark", "dirt",
]

@export var shadow_casters_only_near: bool = false

var _cache: Dictionary = {}


func _ready() -> void:
	apply_materials()


func apply_materials() -> void:
	var bound := 0
	var missed: PackedStringArray = []
	for mi in find_children("*", "MeshInstance3D", true, false):
		var inst := mi as MeshInstance3D
		var key := _key_for(inst.name)
		if key == "":
			continue
		var mat := _load_mat(key)
		if mat == null:
			missed.append(key)
			continue
		inst.material_override = mat
		inst.gi_mode = GeometryInstance3D.GI_MODE_STATIC
		inst.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		inst.lod_bias = 1.4
		bound += 1
	if missed.size() > 0:
		push_warning("arena: missing materials for %s" % str(missed))
	print("[arena] bound %d surface materials" % bound)


func _key_for(node_name: StringName) -> String:
	var n := String(node_name).to_lower()
	for k in KEYS:
		if n.contains(k):
			return k
	return ""


func _load_mat(key: String) -> Material:
	if _cache.has(key):
		return _cache[key]
	var path := MAT_DIR + key + ".tres"
	if not ResourceLoader.exists(path):
		return null
	var m: Material = load(path)
	_cache[key] = m
	return m
