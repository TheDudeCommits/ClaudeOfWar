import * as THREE from 'three';

/**
 * GLSL injections for the character materials.
 *
 * three r185 notes that bit hard while writing these:
 *  - `perturbNormal2Arb` is gone. The tangent frame is the `mat3 tbn` declared
 *    by <normal_fragment_begin>, which exists whenever USE_NORMALMAP_TANGENTSPACE,
 *    USE_CLEARCOAT_NORMALMAP or USE_ANISOTROPY is defined.
 *  - `tbn`, `normal` and `vViewPosition` are all VIEW space.
 *  - onBeforeCompile sees the *unresolved* source, so `#include <x>` can only be
 *    replaced wholesale. Where we need to edit inside a chunk we patch a copy of
 *    THREE.ShaderChunk instead and assert the anchor was found.
 */

function assertPatched(before, after, what) {
  if (before === after) {
    console.error(`[chars] shader patch failed: ${what} — anchor not found in this three build`);
  }
  return after;
}

/* ------------------------------------------------------------------ hair */

const HAIR_COMMON = /* glsl */`
uniform vec3  uHairPivot;
uniform float uStrandDensity;
uniform float uStrandTwist;
uniform float uStrandNormal;
uniform float uStrandContrast;
uniform float uHairAO;
uniform float uHairBreak;
uniform vec2  uHairDetailScale;
uniform vec3  uHairRoot;
uniform sampler2D uHairDetail;
varying vec3 vHairObj;
varying vec3 vHairNObj;
varying vec3 vHairT;

float cowHash( float n ) { return fract( sin( n * 12.9898 ) * 43758.5453123 ); }

// across-strand coord, object Y, fraction within strand, strand id
vec4 cowStrand;
float cowCav;
float cowAO;
`;

const HAIR_VERT_COMMON = /* glsl */`
uniform vec3 uHairPivot;
varying vec3 vHairObj;
varying vec3 vHairNObj;
varying vec3 vHairT;
`;

const HAIR_VERT_TANGENT = /* glsl */`
{
	// Strand frame in REST-POSE object space so the pattern is glued to the
	// surface and does not swim when the skeleton animates. The "across strand"
	// direction is the horizontal circle around the body axis: hair falls, so
	// strands run down the surface and the shine band runs around the head.
	vec3 hq = position - uHairPivot;
	vec3 axial = vec3( - hq.z, 0.0, hq.x );
	if ( dot( axial, axial ) < 1e-8 ) axial = vec3( 1.0, 0.0, 0.0 );
	vec3 tObj = normalize( axial );
	tObj = tObj - normal * dot( tObj, normal );
	if ( dot( tObj, tObj ) < 1e-8 ) tObj = axial;
	tObj = normalize( tObj );
	#ifdef USE_SKINNING
		tObj = ( skinMatrix * vec4( tObj, 0.0 ) ).xyz;
	#endif
	vHairT = normalMatrix * tObj;
}
`;

const HAIR_ALBEDO = /* glsl */`
{
	vec3 hq = vHairObj - uHairPivot;
	float ang = atan( hq.z, hq.x );
	float across = ang * uStrandDensity + hq.y * uStrandTwist;
	float sid = floor( across );
	cowStrand = vec4( across, hq.y, across - sid, sid );

	float h1 = cowHash( sid );
	float h2 = cowHash( sid + 91.7 );

	// rounded strand cross-section: bright on the crown of the strand, dark in
	// the gap between strands. This is what turns a shell into readable hair.
	cowCav = 1.0 - pow( abs( 2.0 * cowStrand.z - 1.0 ), 1.7 );

	// clumps break along their length instead of ruling continuous lines
	float brk = 0.5 + 0.5 * sin( hq.y * ( 26.0 + 20.0 * h2 ) + h1 * 43.0 );

	// cheap volumetric AO: inner shells face back toward the body axis
	float outward = dot( normalize( vHairNObj ),
		normalize( vec3( hq.x, hq.y * 0.18, hq.z ) + vec3( 1e-5 ) ) );
	cowAO = mix( 1.0 - uHairAO, 1.0, smoothstep( -0.45, 0.55, outward ) );

	float shade = mix( 0.50, 1.16, cowCav )
	            * mix( 0.78, 1.16, h1 )
	            * mix( 1.0 - uHairBreak, 1.0 + uHairBreak * 0.25, brk );

	diffuseColor.rgb *= mix( 1.0, shade * cowAO, uStrandContrast );
	// roots and the shadowed interior pick up a warm dark tint — reference hair
	// is never a single flat value from root to tip
	diffuseColor.rgb = mix( diffuseColor.rgb, uHairRoot * ( 0.35 + 0.65 * shade ),
		( 1.0 - cowAO ) * 0.55 );
}
`;

const HAIR_ROUGH = /* glsl */`
roughnessFactor *= mix( 0.70, 1.34, cowHash( cowStrand.w + 313.0 ) );
roughnessFactor += 0.18 * ( 1.0 - cowCav );
roughnessFactor = clamp( roughnessFactor, 0.05, 1.0 );
`;

const HAIR_NORMAL = /* glsl */`
{
	vec3 hT = vHairT - normal * dot( vHairT, normal );
	if ( dot( hT, hT ) < 1e-8 ) hT = tbn[ 0 ];
	hT = normalize( hT );
	vec3 hS = normalize( cross( normal, hT ) );

	vec3 hq = vHairObj - uHairPivot;
	// analytic d(atan2)/d(screen) so the strand map does not blow its mip
	// selection at the angular seam behind the head
	vec2 dqx = dFdx( hq.xz ), dqy = dFdy( hq.xz );
	float r2 = max( dot( hq.xz, hq.xz ), 1e-6 );
	float dAx = ( hq.x * dqx.y - hq.z * dqx.x ) / r2;
	float dAy = ( hq.x * dqy.y - hq.z * dqy.x ) / r2;
	float dYx = dFdx( hq.y ), dYy = dFdy( hq.y );

	vec2 sUv = vec2( cowStrand.x * uHairDetailScale.x, cowStrand.y * uHairDetailScale.y );
	vec2 dUx = vec2( ( dAx * uStrandDensity + dYx * uStrandTwist ) * uHairDetailScale.x,
	                 dYx * uHairDetailScale.y );
	vec2 dUy = vec2( ( dAy * uStrandDensity + dYy * uStrandTwist ) * uHairDetailScale.x,
	                 dYy * uHairDetailScale.y );
	vec3 dn = textureGrad( uHairDetail, sUv, dUx, dUy ).xyz * 2.0 - 1.0;

	float slope = - ( 2.0 * cowStrand.z - 1.0 ) * uStrandNormal;
	normal = normalize( normal + hT * ( slope + dn.x * 1.4 ) + hS * ( dn.y * 0.30 ) );

	// Anisotropic GGX stretches the highlight along tbn[0]; pointing that across
	// the strands gives the band that travels around the head.
	tbn[ 0 ] = hT;
	tbn[ 1 ] = hS;
}
`;

export function injectHair(mat, uniforms) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', () => '#include <common>\n' + HAIR_VERT_COMMON)
      .replace('#include <begin_vertex>',
        () => '#include <begin_vertex>\n\tvHairObj = position;\n\tvHairNObj = normal;')
      // after <defaultnormal_vertex> so skinMatrix and normalMatrix are both live
      .replace('#include <defaultnormal_vertex>',
        () => '#include <defaultnormal_vertex>\n' + HAIR_VERT_TANGENT);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', () => '#include <common>\n' + HAIR_COMMON)
      .replace('#include <map_fragment>', () => '#include <map_fragment>\n' + HAIR_ALBEDO)
      .replace('#include <roughnessmap_fragment>',
        () => '#include <roughnessmap_fragment>\n' + HAIR_ROUGH)
      .replace('#include <normal_fragment_begin>',
        () => '#include <normal_fragment_begin>\n' + HAIR_NORMAL);
  };
  mat.customProgramCacheKey = () => 'cow-hair-v3';
  return mat;
}

/* ------------------------------------------------------------------ skin */

const SKIN_COMMON = /* glsl */`
uniform vec3  uSssColor;
uniform float uSssStrength;
uniform float uSssWrap;
`;

/**
 * Wrapped-diffuse subsurface. three has no real SSS; transmission on a closed
 * skinned body is both expensive and wrong (it needs a backface pass). Wrapping
 * the diffuse term and tinting the extra energy warm reproduces the thing that
 * actually reads on camera: the red terminator and the soft, late falloff into
 * shadow. ART_BIBLE §7 asks for 0.25–0.4 strength, warm #C4544A.
 */
function skinLightingChunk() {
  const src = THREE.ShaderChunk.lights_physical_pars_fragment;
  // The built bundle strips blank lines the src tree has, so match on whitespace
  // rather than an exact literal.
  const anchor = /float dotNL = saturate\( dot\( geometryNormal, directLight\.direction \) \);\s*vec3 irradiance = dotNL \* directLight\.color;/;
  const patched = /* glsl */`float rawNL = dot( geometryNormal, directLight.direction );
	float dotNL = saturate( rawNL );

	vec3 irradiance = dotNL * directLight.color;

	{
		float wrapNL = saturate( ( rawNL + uSssWrap ) / ( 1.0 + uSssWrap ) );
		vec3 sss = ( wrapNL - dotNL ) * directLight.color;
		reflectedLight.directDiffuse += sss * BRDF_Lambert( material.diffuseContribution * uSssColor ) * uSssStrength;
	}`;
  return assertPatched(src, src.replace(anchor, patched), 'skin wrapped diffuse');
}

const SKIN_SHADE = /* glsl */`
{
	// pigment-driven roughness: the T-zone and lips sit oilier than the cheeks,
	// and a constant roughness is an automatic fail (ART_BIBLE §12).
	float sLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	float sNoise = texture2D( normalMap, vNormalMapUv * 0.11 ).g;
	roughnessFactor *= 0.86 + 0.34 * sNoise;
	roughnessFactor -= 0.10 * smoothstep( 0.30, 0.62, sLum );
	roughnessFactor = clamp( roughnessFactor, 0.30, 0.72 );
}
`;

export function injectSkin(mat, uniforms) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', () => '#include <common>\n' + SKIN_COMMON)
      .replace('#include <lights_physical_pars_fragment>', () => skinLightingChunk())
      .replace('#include <roughnessmap_fragment>',
        () => '#include <roughnessmap_fragment>\n' + SKIN_SHADE);
  };
  mat.customProgramCacheKey = () => 'cow-skin-v3';
  return mat;
}

/* ------------------------------------------------------------------ body */

const BODY_COMMON = /* glsl */`
uniform float uMetalBias;
uniform float uWear;
uniform float uRoughLow;
uniform float uRoughHigh;
float cowBodyMetal;
float cowBodyCurv;
`;

const BODY_ALBEDO = /* glsl */`
{
	float mx = max( max( diffuseColor.r, diffuseColor.g ), diffuseColor.b );
	float mn = min( min( diffuseColor.r, diffuseColor.g ), diffuseColor.b );
	float sat = mx > 1e-4 ? ( mx - mn ) / mx : 0.0;
	float lum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );

	// Screen-space curvature stands in for a baked curvature map: convex edges
	// are where paint and dye wear off first.
	cowBodyCurv = clamp( length( fwidth( vNormal ) ) * 5.5, 0.0, 1.0 );

	// Two metal families in the atlas: cold grey fittings and warm bronze trim.
	float grey = smoothstep( 0.17, 0.06, sat ) * smoothstep( 0.045, 0.10, lum ) * smoothstep( 0.46, 0.30, lum );
	float bronze = smoothstep( 0.30, 0.44, sat ) * smoothstep( 0.55, 0.42, sat )
	             * smoothstep( 0.055, 0.11, lum ) * smoothstep( 0.34, 0.20, lum )
	             * step( diffuseColor.b, diffuseColor.g ) * step( diffuseColor.g, diffuseColor.r );
	// metallic is strictly 0 or 1 (ART_BIBLE §7) — the mask decides, not a blend
	cowBodyMetal = step( 0.5, max( grey, bronze ) + uMetalBias );

	vec3 worn = mix( diffuseColor.rgb, vec3( lum * 1.7 + 0.03 ), 0.65 );
	diffuseColor.rgb = mix( diffuseColor.rgb, worn, cowBodyCurv * uWear );
}
`;

const BODY_ROUGH = /* glsl */`
{
	float lum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	float grain = texture2D( normalMap, vNormalMapUv * 0.17 ).g;
	float r = mix( uRoughHigh, uRoughLow, smoothstep( 0.012, 0.20, lum ) );
	r = mix( r, 0.30, cowBodyMetal );
	r *= 0.84 + 0.32 * grain;
	r -= cowBodyCurv * 0.20;
	roughnessFactor = clamp( r, 0.10, 1.0 );
}
`;

const BODY_METAL = /* glsl */`
metalnessFactor = cowBodyMetal;
`;

export function injectBody(mat, uniforms) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', () => '#include <common>\n' + BODY_COMMON)
      .replace('#include <map_fragment>', () => '#include <map_fragment>\n' + BODY_ALBEDO)
      .replace('#include <roughnessmap_fragment>',
        () => '#include <roughnessmap_fragment>\n' + BODY_ROUGH)
      .replace('#include <metalnessmap_fragment>',
        () => '#include <metalnessmap_fragment>\n' + BODY_METAL);
  };
  mat.customProgramCacheKey = () => 'cow-body-v3';
  return mat;
}

/**
 * Draugr: the body classifier (wet dark flesh / dry pale bone, metal fittings,
 * edge wear) plus a weak, green-shifted wrapped-diffuse term for the flesh.
 * One material, no draw-group split — the atlas is near-monochrome, so there is
 * nothing to segment.
 */
export function injectZombie(mat, uniforms) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        () => '#include <common>\n' + SKIN_COMMON + BODY_COMMON)
      .replace('#include <lights_physical_pars_fragment>', () => skinLightingChunk())
      .replace('#include <map_fragment>', () => '#include <map_fragment>\n' + BODY_ALBEDO)
      .replace('#include <roughnessmap_fragment>',
        () => '#include <roughnessmap_fragment>\n' + BODY_ROUGH)
      .replace('#include <metalnessmap_fragment>',
        () => '#include <metalnessmap_fragment>\n' + BODY_METAL);
  };
  mat.customProgramCacheKey = () => 'cow-zombie-v3';
  return mat;
}
