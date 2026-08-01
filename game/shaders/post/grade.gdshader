shader_type canvas_item;
render_mode blend_disabled, unshaded;

// ClaudeOfWar final grade / film pass.
// Runs on a full-screen ColorRect inside world.tscn's CanvasLayer, i.e. AFTER
// the 3D pipeline has already done SSAO/SSIL/SSR/fog/glow/ACES/DOF.
// Everything Godot's Environment cannot do lives here:
//   radial chromatic aberration -> CAS-style sharpen -> S-curve + split-tone +
//   desaturation + black lift -> animated luma-weighted grain -> soft elliptical
//   vignette.
// ART_BIBLE 4 wants sharpen last; it is applied before grain here on purpose so
// the sharpen filter does not amplify the grain into aliasing.

uniform sampler2D screen_tex : hint_screen_texture, repeat_disable, filter_linear;

// --- tone ---------------------------------------------------------------
uniform float exposure_bias : hint_range(0.25, 4.0) = 1.0;
uniform float contrast : hint_range(0.0, 1.0) = 0.22;      // S-curve blend
uniform float saturation : hint_range(0.0, 2.0) = 0.87;
uniform vec3 black_point : source_color = vec3(0.047, 0.063, 0.086); // #0C1016

// --- split tone ---------------------------------------------------------
uniform vec3 shadow_tint : source_color = vec3(0.18, 0.29, 0.36);
uniform vec3 highlight_tint : source_color = vec3(1.0, 0.85, 0.66);
uniform float shadow_tint_strength : hint_range(0.0, 1.0) = 0.30;
uniform float highlight_tint_strength : hint_range(0.0, 1.0) = 0.22;

// --- lens ---------------------------------------------------------------
uniform float ca_amount : hint_range(0.0, 0.02) = 0.006;   // radial only
uniform float sharpen_amount : hint_range(0.0, 1.5) = 0.30;
uniform float grain_amount : hint_range(0.0, 0.12) = 0.026;
uniform float grain_size : hint_range(0.5, 4.0) = 1.35;
uniform float vignette_amount : hint_range(0.0, 1.0) = 0.34;
uniform float vignette_inner : hint_range(0.0, 1.0) = 0.28;
uniform float vignette_ellipse : hint_range(0.5, 2.0) = 1.12; // >1 = taller falloff
uniform float grain_time = 0.0;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float luma(vec3 c) { return dot(c, LUMA); }

// Dave Hoskins style hash. The naive fract(p*vec2(a,b)) variant aliases into
// visible vertical stripes at 1080p, which is exactly what we do not want from
// a "film grain" pass.
float hash21(vec2 p) {
	vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

float grain_noise(vec2 p) {
	// two octaves so the grain has structure instead of reading as pure salt
	return hash21(p) * 0.65 + hash21(p * 2.17 + vec2(41.3, 17.7)) * 0.35;
}

vec3 s_curve(vec3 x) {
	vec3 s = x * x * (3.0 - 2.0 * x);
	return mix(x, s, contrast);
}

void fragment() {
	vec2 uv = SCREEN_UV;
	vec2 texel = 1.0 / vec2(textureSize(screen_tex, 0));
	vec2 res = vec2(textureSize(screen_tex, 0));

	// ---- radial chromatic aberration -----------------------------------
	vec2 c = uv - 0.5;
	float r2 = dot(c, c);
	vec2 rad = c * r2 * ca_amount * 4.0;
	vec3 col;
	col.r = texture(screen_tex, uv + rad).r;
	col.g = texture(screen_tex, uv).g;
	col.b = texture(screen_tex, uv - rad).b;

	// ---- contrast-adaptive-ish sharpen ---------------------------------
	if (sharpen_amount > 0.001) {
		vec3 n = texture(screen_tex, uv + vec2(0.0, -texel.y)).rgb;
		vec3 s = texture(screen_tex, uv + vec2(0.0, texel.y)).rgb;
		vec3 e = texture(screen_tex, uv + vec2(texel.x, 0.0)).rgb;
		vec3 w = texture(screen_tex, uv + vec2(-texel.x, 0.0)).rgb;
		vec3 blur = (n + s + e + w) * 0.25;
		vec3 hi = col - blur;
		// attenuate where local contrast is already extreme -> no ringing
		float lc = clamp(1.0 - length(hi) * 3.0, 0.0, 1.0);
		col += hi * sharpen_amount * lc;
	}

	col = max(col, vec3(0.0)) * exposure_bias;

	// ---- into a perceptual working space -------------------------------
	// The 3D buffer is linear post-ACES; grading maths reads correctly in a
	// gamma-ish space, which is also where a colourist would work.
	vec3 g = pow(col, vec3(1.0 / 2.2));

	// S-curve contrast around mid grey
	g = s_curve(clamp(g, 0.0, 1.4));

	// teal / orange split tone
	float l = clamp(luma(g), 0.0, 1.0);
	float shw = pow(1.0 - l, 2.0);
	float hiw = pow(l, 1.6);
	vec3 sh_srgb = pow(max(shadow_tint, vec3(0.0)), vec3(1.0 / 2.2));
	vec3 hi_srgb = pow(max(highlight_tint, vec3(0.0)), vec3(1.0 / 2.2));
	g += (sh_srgb - vec3(luma(sh_srgb))) * shw * shadow_tint_strength;
	g += (hi_srgb - vec3(luma(hi_srgb))) * hiw * highlight_tint_strength;

	// desaturate
	g = mix(vec3(luma(g)), g, saturation);

	// black lift: nothing in frame is pure black
	vec3 bp = pow(max(black_point, vec3(0.0)), vec3(1.0 / 2.2));
	g = bp + g * (vec3(1.0) - bp);

	// ---- film grain: animated, luma weighted ---------------------------
	if (grain_amount > 0.0001) {
		vec2 gp = uv * res / grain_size + vec2(fract(grain_time * 0.713) * 512.0,
				fract(grain_time * 1.137) * 512.0);
		float n0 = grain_noise(gp) - 0.5;
		float lw = clamp(luma(g), 0.0, 1.0);
		// strongest in the low mids, almost gone in blown highlights
		float w = (1.0 - smoothstep(0.35, 1.0, lw)) * (0.35 + 0.65 * smoothstep(0.0, 0.22, lw));
		g += n0 * grain_amount * 2.0 * w;
	}

	// ---- soft elliptical vignette --------------------------------------
	vec2 vd = c * vec2(1.0, vignette_ellipse);
	float d = length(vd) * 1.4142;
	float vig = 1.0 - vignette_amount * smoothstep(vignette_inner, 1.05, d);
	g *= vig;

	col = pow(max(g, vec3(0.0)), vec3(2.2));

	COLOR = vec4(col, 1.0);
}
