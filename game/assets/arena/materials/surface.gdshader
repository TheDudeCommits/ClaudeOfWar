shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back, diffuse_burley,
	specular_schlick_ggx;

// Shared PBR surface for every arena material except the ground.
// Roughness/metallic/AO come out of a packed ORM map (R=AO, G=rough, B=metal)
// so nothing in this scene is ever a constant-roughness plastic (ART_BIBLE 7).
// On top of that: a high-tiling detail normal for micro response and a very
// low-frequency macro multiplier that breaks up visible texture repetition.

uniform sampler2D albedo_tex : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D orm_tex : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D detail_normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D macro_tex : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;

uniform vec4 tint : source_color = vec4(1.0, 1.0, 1.0, 1.0);
uniform float uv_scale = 1.0;
uniform float normal_strength = 1.0;
uniform float detail_scale = 7.0;
uniform float detail_strength = 0.5;
uniform float macro_scale = 0.06;
uniform float macro_strength = 0.35;
uniform float roughness_mul = 1.0;
uniform float roughness_add = 0.0;
uniform float metallic_mul = 1.0;
uniform float ao_affect : hint_range(0.0, 1.0) = 0.28;
uniform float specular_v : hint_range(0.0, 1.0) = 0.5;
uniform float vcol_strength : hint_range(0.0, 1.0) = 1.0;
uniform float sss : hint_range(0.0, 1.0) = 0.0;
uniform float backlight_v : hint_range(0.0, 1.0) = 0.0;
uniform vec4 sss_tint : source_color = vec4(0.85, 0.9, 1.0, 1.0);

vec3 blend_normals(vec3 base, vec3 det, float s) {
	return normalize(vec3(base.xy + det.xy * s, base.z * mix(1.0, det.z, s * 0.5)));
}

void fragment() {
	vec2 uv = UV * uv_scale;

	vec3 alb = texture(albedo_tex, uv).rgb;
	vec3 orm = texture(orm_tex, uv).rgb;

	vec3 n = texture(normal_tex, uv).xyz * 2.0 - 1.0;
	n.xy *= normal_strength;
	n = normalize(n);
	vec3 dn = texture(detail_normal_tex, uv * detail_scale).xyz * 2.0 - 1.0;
	n = blend_normals(n, dn, detail_strength);

	float macro = texture(macro_tex, uv * macro_scale).r;
	float macro_mul = mix(1.0, macro * 1.45 + 0.10, macro_strength);

	vec3 vc = mix(vec3(1.0), COLOR.rgb, vcol_strength);

	ALBEDO = alb * tint.rgb * vc * macro_mul;
	NORMAL_MAP = n * 0.5 + 0.5;
	NORMAL_MAP_DEPTH = 1.0;
	ROUGHNESS = clamp(orm.g * roughness_mul + roughness_add, 0.02, 1.0);
	METALLIC = clamp(orm.b * metallic_mul, 0.0, 1.0);
	AO = orm.r;
	AO_LIGHT_AFFECT = ao_affect;
	SPECULAR = specular_v;
	if (sss > 0.0) {
		SSS_STRENGTH = sss;
	}
	if (backlight_v > 0.0) {
		BACKLIGHT = sss_tint.rgb * backlight_v;
	}
}
