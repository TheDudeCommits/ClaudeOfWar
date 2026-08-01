shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back, diffuse_burley,
	specular_schlick_ggx;

// Two-layer ground: village flagstone under wind-packed snow.
//
// The snow coverage mask is baked into vertex colour R by the Blender build
// (bare stone along the trodden route, deep drifts against the ruins). Snow
// settles into cavities first: the rock AO channel biases the blend so the
// transition follows the stone's own relief instead of reading as a decal.
// Two different UV scales plus a low-frequency macro multiplier keep the
// 20x20 m floor from showing obvious tiling.

uniform sampler2D rock_alb : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D rock_nrm : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D rock_orm : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D snow_alb : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D snow_nrm : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D snow_orm : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D detail_normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D macro_tex : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;

uniform float rock_uv = 1.0;
uniform float snow_uv = 0.62;
uniform float detail_scale = 9.0;
uniform float detail_strength = 0.45;
uniform float macro_scale = 0.055;
uniform float macro_strength = 0.40;
uniform float snow_bias = 0.0;
uniform float blend_sharp : hint_range(0.02, 0.5) = 0.20;
uniform float cavity_bias : hint_range(0.0, 1.0) = 0.42;
uniform float ao_affect : hint_range(0.0, 1.0) = 0.30;
uniform float snow_sss : hint_range(0.0, 1.0) = 0.30;
uniform vec4 rock_tint : source_color = vec4(1.0, 1.0, 1.0, 1.0);
uniform vec4 snow_tint : source_color = vec4(1.0, 1.0, 1.0, 1.0);

vec3 blend_normals(vec3 base, vec3 det, float s) {
	return normalize(vec3(base.xy + det.xy * s, base.z * mix(1.0, det.z, s * 0.5)));
}

void fragment() {
	vec2 uvr = UV * rock_uv;
	vec2 uvs = UV * snow_uv;

	vec3 ra = texture(rock_alb, uvr).rgb * rock_tint.rgb;
	vec3 ro = texture(rock_orm, uvr).rgb;
	vec3 rn = normalize(texture(rock_nrm, uvr).xyz * 2.0 - 1.0);

	vec3 sa = texture(snow_alb, uvs).rgb * snow_tint.rgb;
	vec3 so = texture(snow_orm, uvs).rgb;
	vec3 sn = normalize(texture(snow_nrm, uvs).xyz * 2.0 - 1.0);

	// snow fills the low ground first
	float cavity = 1.0 - ro.r;
	float m = COLOR.r * 1.30 - 0.16 + snow_bias + cavity * cavity_bias;
	float t = smoothstep(0.5 - blend_sharp, 0.5 + blend_sharp, m);

	float macro = texture(macro_tex, uvr * macro_scale).r;
	float macro_mul = mix(1.0, macro * 1.45 + 0.10, macro_strength);
	float grime = mix(1.0, COLOR.g, 0.85);

	vec3 n = mix(rn, sn, t);
	vec3 dn = texture(detail_normal_tex, uvr * detail_scale).xyz * 2.0 - 1.0;
	n = blend_normals(normalize(n), dn, detail_strength * (1.0 - t * 0.45));

	ALBEDO = mix(ra, sa, t) * macro_mul * grime;
	NORMAL_MAP = n * 0.5 + 0.5;
	NORMAL_MAP_DEPTH = 1.0;
	ROUGHNESS = clamp(mix(ro.g, so.g, t), 0.04, 1.0);
	METALLIC = 0.0;
	AO = mix(ro.r, so.r, t);
	AO_LIGHT_AFFECT = ao_affect;
	SPECULAR = 0.5;
	SSS_STRENGTH = snow_sss * t;
}
