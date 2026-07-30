# ClaudeOfWar — Art Bible

Derived by direct measurement of the God of War Ragnarök reference plates in
`reference/Reference/`. This is the target. Every builder and critic agent works
against this document.

## 0. The one-line target

A third-person, over-the-shoulder hack-and-slash whose **still frames** are
indistinguishable from a PS5 first-party action title when placed beside a GoW
Ragnarök screenshot by a hostile judge.

The judge is looking at stills. Therefore **framing, lighting, material response,
atmospheric depth, and post-process grade** carry ~80% of the verdict. Polygon
count carries almost none. Optimize accordingly.

---

## 1. Camera — the single most identifying trait

Measured from `god-of-war-ragnarok-pc-screenshot-pitmine-combat-02-en-10may24-1.webp`,
`images (15).jpeg`, and `the-god-of-war-universe...jpg`:

| Property | Value | Notes |
|---|---|---|
| Rig | Over-the-shoulder, **right shoulder**, camera low | Hero's head sits at ~0.42–0.55 of frame height |
| Hero screen area | **22–35% of frame** | This is the #1 tell. Web games put the camera too far back. |
| Hero horizontal | Left third, centered ~0.28–0.38 x | Enemy occupies the right two-thirds |
| FOV | **50–62°** vertical-ish, wide and close | NOT 45. Wide FOV + close distance = the GoW look |
| Pitch | −4° to −12° (slightly down) | Almost never level, never high-angle |
| Distance | 1.6–2.6 m from hero's chest | Extremely close |
| Height | 1.5–1.75 m (shoulder/head height) | Never above the head |
| Roll | 0°, except ±1.5° during impacts | |
| Near clip | 0.05 | Hero's shoulder clips very close |

The camera **is not a spectator**. It is a participant riding the hero's shoulder.
If the shot looks like a third-person camera "watching" the character from a
polite distance, it has already lost.

## 2. Composition

- **Layered depth, always.** Every frame has ≥4 readable depth planes:
  1. Hero shoulder/weapon (0.5–2 m, may be partially out of focus)
  2. Combat plane — enemies (4–9 m, tack sharp)
  3. Mid set dressing — structures, debris, posts (12–40 m)
  4. Far silhouette — cliffs, ships, architecture washed into fog (60 m+)
- **Occluders on frame edges.** Ref plates almost always have a dark out-of-focus
  branch, beam, rope, or rock intruding from an edge. This sells depth for free.
- **Nothing is empty.** No untextured floor spans more than ~15% of frame.
  Debris, decals, footprint scuffs, puddles, gravel, snow drift.
- **Diagonals.** Broken beams, spears, ramps run diagonally. Horizontals read flat.

## 3. Lighting

Two dominant lighting recipes appear in the reference set. Support both.

### 3a. "Cold Overcast Ruin" (`images (15)`, pitmine plate)
- Key: sun, low, ~15–25° elevation, raking. Colour `#FFE3C0`–`#FFD9A8`, energy high.
- Sky: bright but grey-blue, `#8FA4B8` horizon → `#3E6394` zenith.
- Ambient/GI: cool, `#5A6E88`, strong bounce off snow.
- Shadows: **soft, long, blue-shifted**. Shadow colour is never black — it is
  the ambient sky colour. Blackened shadows are the #1 amateur tell.
- Volumetric fog: light density (0.02–0.04), high-ish, catches sun as god rays.

### 3b. "Ember Hellscape" (`the-god-of-war-universe...`)
- Key: warm orange, low, from behind/side. Rim-lights the hero hard.
- Fill: magenta/violet `#7A3D8F` from opposite side. **Complementary split.**
- Emissives everywhere: fires, embers, glowing runes, all blooming.
- Volumetric fog: heavy (0.06–0.10), warm, smoke-like, tinted by fires.
- Shadows crushed but tinted violet, never neutral black.

**Universal rules:**
- Sun elevation **never above 35°**. Overhead sun kills form.
- Always a rim/back light separating hero from background. Always.
- Light the *silhouette* first. If the hero's outline isn't readable in a
  thumbnail, the lighting has failed.
- Real-time GI on (SDFGI) + SSIL. Bounce light is what makes it read as "next-gen".

## 4. Post-process chain (order matters)

```
scene HDR
 → SSAO (radius 0.6, intensity 1.6, light_affect 0.25)
 → SSIL (radius 3.5, intensity 1.1)   # colour bleed — big quality win
 → SSR (max steps 96, fade 2.0)       # wet stone, metal, ice
 → Volumetric fog (density per recipe, GI inject 1.0)
 → Auto-exposure (min 0.12 max 2.4, speed 1.2)
 → Bloom / glow (threshold ~0.9 HDR, intensity 0.35, 7 levels, soft)
 → Tonemap: ACES, white 6.0–8.0, exposure 1.0
 → Colour grade LUT (see §5)
 → Depth of field (see §6)
 → Chromatic aberration (0.0015–0.004, radial only)
 → Film grain (0.018–0.035, animated, luma-weighted)
 → Vignette (0.25–0.4, soft, slightly elliptical)
 → Sharpen (FSR/CAS 0.3) LAST
```

**ACES is mandatory.** Reinhard/Filmic look washed and flat by comparison. The
highlight rolloff on ACES is a large part of "cinematic".

## 5. Colour grade

Ref plates are **not** saturated. Measured character:
- Shadows lifted slightly and pushed **cool** (blue/teal), never crushed to 0.
- Midtones desaturated ~12–18% from raw render.
- Highlights pushed **warm** (amber), rolled off softly.
- Overall a gentle teal/orange split-tone. Contrast S-curve, mild.
- Blacks sit at ~`#0C1016`, not `#000000`. **Nothing in the frame is pure black
  or pure white** except specular hits and emissives.

## 6. Depth of field

- Focus on the combat plane (enemy / lock-on target), ~6 m.
- Near blur: hero shoulder softly out of focus. Subtle — 2–4 px.
- Far blur: strong. Background structures visibly soft, 8–16 px.
- Bokeh shape: circular, 6 blades.
- This one effect does more for "AAA" than any amount of geometry.

## 7. Materials

Godot StandardMaterial3D / ORM. Every hero-visible surface needs:
- Albedo with **real value range** (0.04–0.85 linear; no pure white/black albedo)
- Normal map with detail-normal overlay at 8–20× tiling
- Roughness map, **never a constant**. Variation is what makes it read as real.
- Metallic strictly 0 or 1 (mixed values only via mask)
- AO baked
- Wear: edge-wear via curvature-driven roughness/albedo lightening

Look targets:
- **Leather** — roughness 0.55–0.8, mottled, cracked normals, slight sheen at grazing
- **Iron/steel** — metallic 1, roughness 0.25–0.45, scratched anisotropic feel,
  visible environment reflection via SSR/reflection probe
- **Gold/bronze trim** — metallic 1, roughness 0.18–0.3, warm tint `#C9A227`
- **Skin** — subsurface scattering ON (strength 0.25–0.4, warm `#C4544A`),
  roughness 0.42–0.55, slight specular
- **Snow** — high albedo 0.82, roughness 0.6, subtle SSS, sparkle via detail normal
- **Wet stone** — roughness 0.2 in puddle mask, SSR on, darkened albedo
- **Cloth/fur** — sheen enabled, backscatter, anisotropic

## 8. Characters (anime-style fighters)

The roster is anime-styled; the *rendering* is photoreal. This is the
"Guilty Gear Strive / Genshin at PS5 fidelity" axis, NOT flat cel-shading.
- Stylized proportions (heads slightly larger, sharper features, dramatic hair)
- **Rendered with the same PBR/SSS/GI stack as everything else** — no toon ramp
  as the primary shading model. A subtle rim + slightly compressed diffuse ramp
  is acceptable; a hard 2-band cel shader is an instant loss against the ref.
- Hair: card-based with anisotropic specular, not opaque blobs
- Cloth simulated or at minimum jiggle-boned; static cloth reads dead
- Eyes: parallax/refractive cornea, catchlight always present

## 9. Enemies (zombies)

- Draugr-adjacent: desiccated, frost-bitten or rot-bitten, exposed bone
- Emissive detail (glowing eyes/cracks) — reads well against fog, gives bloom
- Silhouette variety across the roster: heavy/brute, fast/lean, ranged
- Wet/greasy specular on exposed flesh; dry roughness on bone and cloth

## 10. VFX

- **Impact = light.** Every hit spawns a brief omni light (warm, 0.06 s).
- Weapon trails: ribbon meshes, additive, tapered, 4–7 frame lifetime
- Sparks: GPU particles, stretched billboards, gravity + drag, bright HDR values
- Blood: dark, low-saturation `#4A0E0E`, arcs + decals on ground
- Ambient: embers, snow, dust motes, pollen — **always something in the air**.
  Empty air reads as cheap. 200–600 particles drifting, lit by the sun.
- Everything additive must exceed 1.0 HDR so bloom catches it.

## 11. Combat feel (judged on frames + code review)

- Hitstop: 60–110 ms on connect, scaled by damage. Freeze both actors.
- Screen shake: 2–5 px, decaying, directional along impact normal.
- Camera punch: 3–6° FOV dip over 120 ms.
- Recovery/commitment: attacks are non-cancellable after the active frame.
- Enemy hit reactions: directional, additive on the skeleton, not full-body.
- Parry window 120 ms; dodge i-frames 300 ms.

## 12. Instant-fail tells (the critic hunts these first)

1. Camera too far back / too high — the game looks like a demo, not GoW
2. Pure black shadows or pure black background
3. No depth of field
4. Flat/absent fog — no aerial perspective, background as sharp as foreground
5. Constant roughness materials (plastic look)
6. Empty air (no particles) and empty ground (no debris/decals)
7. Overhead or high-elevation sun
8. Oversaturated colour
9. Untextured or single-colour large surfaces
10. No rim light on the hero
11. Visible hard shadow acne / low shadow resolution
12. UI that looks like default engine UI
