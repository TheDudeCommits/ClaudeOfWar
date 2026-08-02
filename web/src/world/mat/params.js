/**
 * Per-surface macro-breakup parameters.
 *
 * A single tiling scale is as strong a tell as a single roughness value: our
 * ground measured lag-4 autocorrelation r=0.94 against the reference's 0.756,
 * i.e. visibly periodic. `macroScale` is deliberately a small multiplier on the
 * base UV so the mask's period lands ~20x the base tile and actually breaks the
 * repeat rather than adding another high-frequency layer on top of it.
 *
 * `roughRemap` remaps the ORM roughness into a floor..ceiling window instead of
 * scaling it. rock_orm.png bottoms out at 0.278, and a raking sun mirrors off
 * anything that glossy into near-white specks — that is where the ground's
 * glitter and a 20x-reference pure_white_frac came from.
 */
export const DEFAULT_PARAMS = {
  macroScale: 0.35,
  macroAlbedo: [0.62, 1.14],   // multiplier range driven by the mask
  macroRough: 0.35,            // +/- added to roughness
  roughRemap: [0.58, 0.95],    // floor, ceiling
  wetThreshold: 0.20,          // mask value below which the surface reads wet
  wetRough: 0.40,
  wetDarken: 0.35,
};

export const SURFACE_PARAMS = {
  // The ground is the largest object in frame and the worst offender, so it
  // gets the widest albedo swing and the most aggressive wet/dry zoning.
  ground: { macroScale: 0.30, macroAlbedo: [0.55, 1.15], macroRough: 0.40,
            roughRemap: [0.60, 0.96], wetThreshold: 0.22, wetRough: 0.42, wetDarken: 0.40 },
  rock:   { macroScale: 0.55, macroAlbedo: [0.66, 1.10], macroRough: 0.32,
            roughRemap: [0.58, 0.94], wetThreshold: 0.16, wetRough: 0.44, wetDarken: 0.26 },
  stone:  { macroScale: 0.60, macroAlbedo: [0.68, 1.12], macroRough: 0.30,
            roughRemap: [0.56, 0.93], wetThreshold: 0.16, wetRough: 0.44, wetDarken: 0.30 },
  dirt:   { macroScale: 0.40, macroAlbedo: [0.58, 1.12], macroRough: 0.36,
            roughRemap: [0.62, 0.97], wetThreshold: 0.22, wetRough: 0.42, wetDarken: 0.42 },
  // Snow must not go wet — dark patches in snow read as bugs, not as water.
  snow:   { macroScale: 0.45, macroAlbedo: [0.80, 1.06], macroRough: 0.26,
            roughRemap: [0.48, 0.82], wetThreshold: -1.0, wetDarken: 0.0 },
  wood:   { macroScale: 0.70, macroAlbedo: [0.64, 1.10], macroRough: 0.30,
            roughRemap: [0.55, 0.92], wetThreshold: 0.14, wetRough: 0.46, wetDarken: 0.30 },
  // Metal keeps a low floor on purpose: iron should still catch a highlight.
  iron:   { macroScale: 0.80, macroAlbedo: [0.70, 1.08], macroRough: 0.24,
            roughRemap: [0.28, 0.72], wetThreshold: -1.0, wetDarken: 0.0 },
  fibre:  { macroScale: 0.75, macroAlbedo: [0.66, 1.10], macroRough: 0.28,
            roughRemap: [0.60, 0.95], wetThreshold: 0.14, wetRough: 0.46, wetDarken: 0.24 },
};
