"""Turn a Meshy character GLB into a ClaudeOfWar PBR material set.

Meshy ships exactly one texture: base colour. The glTF material it writes is
actively harmful — fully emissive, metallic 1.0, roughness 1.0, no normal — so
everything ART_BIBLE §7 asks for has to be authored here.

Method: rasterize the mesh's 3D position and normal into the UV atlas, then
classify every texel into a material zone using colour *and* body position.
Position is what disambiguates the cases colour alone cannot: near-white and
low-saturation is hair on the skull, frost on a boot and a steel highlight on a
pauldron, and only the height/radius of the texel tells them apart.

From the zone map we author roughness (per-zone range + multi-octave variation
+ edge wear), a strictly 0-or-1 metallic mask, a detail normal built from the
painted albedo's own high-frequency content plus per-zone procedural detail, a
cavity/AO map, and a subsurface mask so skin scatters and leather does not.

    python3 author_maps.py <char.glb> <out_dir> <preset>     preset: hero|zombie
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import texlib as T                                        # noqa: E402
from glb import Glb, rasterize_uv                         # noqa: E402

SIZE = 2048

# Zone ids
OTHER, SKIN, HAIR, LEATHER, METAL, CLOTH, EYE, BONE = range(8)
ZONE_NAMES = ["other", "skin", "hair", "leather", "metal", "cloth", "eye", "bone"]
ZONE_DEBUG = np.array([
    [1.0, 0.0, 1.0],   # other   magenta (should be rare)
    [1.0, 0.62, 0.45],  # skin
    [0.95, 0.95, 0.95],  # hair
    [0.55, 0.20, 0.16],  # leather
    [0.30, 0.60, 1.00],  # metal
    [0.15, 0.70, 0.55],  # cloth
    [1.00, 1.00, 0.00],  # eye
    [0.90, 0.85, 0.55],  # bone
], np.float32)


# --------------------------------------------------------------- zone rules

def classify(alb: np.ndarray, hsv: np.ndarray, posmap: np.ndarray,
             cov: np.ndarray, preset: str) -> np.ndarray:
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    py = posmap[..., 1]                      # metres above the floor
    px = np.abs(posmap[..., 0])              # distance from the midline
    pz = posmap[..., 2]

    z = np.full(alb.shape[:2], OTHER, np.uint8)

    if preset == "hero":
        head = py > 1.50
        warm = ((h < 0.115) | (h > 0.95))

        # Base cloth: everything dark and desaturated that is not on the head.
        z[(s < 0.30) & (v < 0.42)] = CLOTH

        # Teal half-cape.
        z[(h > 0.40) & (h < 0.58) & (s > 0.22)] = CLOTH

        # Leather: oxblood harness and brown belts/boots.
        z[warm & (s > 0.28) & (v >= 0.12) & (v < 0.56)] = LEATHER

        # Blackened steel pauldron: near-black, sits at shoulder height.
        z[(s < 0.22) & (v < 0.17)] = METAL
        # Bronze knotwork / buckles: yellower and more saturated than skin, and
        # far darker than skin ever gets.
        z[(h > 0.075) & (h < 0.16) & (s > 0.34) & (v > 0.22) & (v < 0.62)] = METAL

        # Skin last-but-one so it wins over the dark-cloth rule on shaded flesh.
        skin = warm & (s > 0.13) & (s < 0.58) & (v > 0.56)
        z[skin] = SKIN

        # Hair: bright and desaturated. Gated above the waist only — the front
        # locks reach mid-chest and nothing else on this character is both bright
        # and desaturated down there.
        hair = (s < 0.14) & (v > 0.66) & (py > 0.95)
        z[hair] = HAIR

        # Eyes: the only saturated cool texels anywhere on the head.
        eye = head & (px < 0.11) & (pz > 0.0) & (
            ((h > 0.28) & (h < 0.72) & (s > 0.14)) | (v < 0.22))
        z[eye] = EYE

    else:                                                  # zombie / draugr
        # The draugr atlas is near-monochrome: hide, rotted wool and corroded
        # mail all sit within a few percent of the same grey-green, so hue and
        # value cannot separate them. Body region does most of the work, and a
        # local high-frequency measure finds the chainmail, whose woven dot
        # pattern is the only genuinely high-detail thing on the character.
        lum = T.luminance(alb)
        detail = np.abs(lum - T.box_blur(lum, 2))
        detail = T.box_blur(detail, 3)
        # 95th percentile of the detail field: the woven mail is the only thing
        # on the model that reaches it. A lower cut swallows the whole atlas,
        # because desiccated hide is itself high-frequency.
        weave = detail > 0.105

        bare_arm = px > 0.195                      # forearms and hands
        bare_leg = py < 0.62                       # below the tunic hem
        head = py > 1.52
        torso = (py > 0.80) & (py < 1.46) & (px < 0.19)

        bone = (h > 0.06) & (h < 0.20) & (s > 0.16) & (v > 0.52)
        metal = (weave & (py > 0.75) & (py < 1.55) & (v < 0.62)) | ((s < 0.22) & (v < 0.15))
        cloth = torso & ~metal & ~bone
        # Cloth foot-wraps.
        cloth |= (py < 0.20) & ~metal
        skin = head | bare_arm | bare_leg

        z[:] = SKIN
        z[cloth] = CLOTH
        z[metal] = METAL
        z[skin & ~metal & ~bone] = SKIN
        z[bone] = BONE
        # Empty sockets read as deep shadow: matte, dark, and never given a
        # cornea highlight. They get emission instead (see author()).
        z[(v < 0.15) & (py > 1.60)] = OTHER

    z[~cov] = OTHER
    return z


# ------------------------------------------------------------------ authoring

# per zone: (rough_lo, rough_hi, metallic, sss, spec)
ZONE_ROUGH = {
    OTHER:   (0.62, 0.88, 0.0, 0.0),
    SKIN:    (0.42, 0.56, 0.0, 1.0),
    HAIR:    (0.28, 0.52, 0.0, 0.12),
    LEATHER: (0.54, 0.82, 0.0, 0.0),
    METAL:   (0.20, 0.44, 1.0, 0.0),
    CLOTH:   (0.68, 0.94, 0.0, 0.0),
    EYE:     (0.04, 0.10, 0.0, 0.0),
    BONE:    (0.38, 0.62, 0.0, 0.35),
}


# Target mean LINEAR albedo per zone. Real diffuse albedos, not the values a
# flat-lit turnaround renderer paints — see the comment in author().
ALBEDO_TARGETS = {
    "hero": {
        SKIN:    (0.440, 0.310, 0.250),   # light warm flesh
        HAIR:    (0.170, 0.166, 0.160),   # white hair reads white via specular, not diffuse
        LEATHER: (0.085, 0.048, 0.042),   # dark oxblood / brown hide
        CLOTH:   (0.075, 0.090, 0.088),   # deep teal wool, charcoal trousers
        METAL:   (0.055, 0.050, 0.046),   # blackened steel: reflects almost nothing
        BONE:    (0.360, 0.330, 0.260),
        OTHER:   (0.140, 0.132, 0.126),   # catch-all: never leave raw values
    },
    "zombie": {
        SKIN:    (0.150, 0.148, 0.120),   # desiccated grey-green hide
        CLOTH:   (0.090, 0.085, 0.070),   # rotted wool, grave dirt
        METAL:   (0.095, 0.080, 0.062),   # corroded iron
        BONE:    (0.330, 0.300, 0.220),
        OTHER:   (0.110, 0.105, 0.092),
    },
}


def author(alb: np.ndarray, zone: np.ndarray, posmap: np.ndarray,
           nrmmap: np.ndarray, cov: np.ndarray, preset: str) -> dict:
    shape = alb.shape[:2]
    lum = T.luminance(alb)

    # --- broadband variation. Three octave sets so roughness never repeats at a
    # single scale, which is what makes a constant-roughness surface obvious.
    n_broad = T.fbm(shape, 6, 5, 11)
    n_mid = T.fbm(shape, 48, 4, 23)
    n_fine = T.fbm(shape, 220, 3, 31)
    crack = T.ridged(shape, 90, 4, 47)
    # Discrete cells, not smooth fbm: pores are individual dimples and the
    # difference is obvious the moment a face fills a third of the frame.
    pores = 1.0 - T.voronoi(shape, 1400, 59)[0]
    pores = pores * 0.75 + T.fbm(shape, 420, 2, 63) * 0.25
    scr = T.scratches(shape, 900, 71, length=0.10, width=1)

    # --- height field: the painted albedo already carries stitch lines, strand
    # streaks and leather grain, so high-passing it recovers real detail that no
    # amount of procedural noise would place correctly.
    hp = lum - T.box_blur(lum, 3)
    hp = np.clip(hp * 3.0, -1.0, 1.0)
    hp_fine = lum - T.box_blur(lum, 1)

    height = hp * 0.50
    rough = np.zeros(shape, np.float32)
    metal = np.zeros(shape, np.float32)
    sss = np.zeros(shape, np.float32)

    for zid, (lo, hi, met, ss) in ZONE_ROUGH.items():
        m = zone == zid
        if not m.any():
            continue
        if zid == SKIN:
            # Oil map: forehead/nose/cheekbone shine. Low-frequency so it reads
            # as sebum, not noise; pore detail sits on top of it.
            r = lo + (hi - lo) * (0.35 * n_broad + 0.35 * n_mid + 0.30 * n_fine)
            r -= 0.05 * (1.0 - n_broad)
            # Skin relief is pores, not whatever noise the generator painted
            # into the albedo, so the high-pass is mostly discarded here.
            height[m] = hp[m] * 0.12 + (pores[m] - 0.5) * 0.55 + hp_fine[m] * 0.18
        elif zid == LEATHER:
            r = lo + (hi - lo) * (0.55 * n_mid + 0.45 * crack)
            r += 0.10 * crack                      # cracks are drier than the field
            height[m] = hp[m] * 0.45 + (crack[m] - 0.5) * 0.55 + (n_fine[m] - 0.5) * 0.20
        elif zid == METAL:
            r = lo + (hi - lo) * (0.6 * n_mid + 0.4 * n_broad)
            r -= 0.14 * scr                        # polished scratch bottoms
            height[m] = hp[m] * 0.30 + (n_fine[m] - 0.5) * 0.12 + scr[m] * 0.06
        elif zid == CLOTH:
            weave = np.abs(np.sin(np.linspace(0, np.pi * SIZE / 3.0, shape[1]))[None, :]) * \
                    np.abs(np.sin(np.linspace(0, np.pi * SIZE / 3.0, shape[0]))[:, None])
            r = lo + (hi - lo) * (0.6 * n_mid + 0.4 * n_fine)
            r -= 0.06 * weave
            height[m] = hp[m] * 0.45 + (weave[m] - 0.5) * 0.20 + (n_fine[m] - 0.5) * 0.25
        elif zid == HAIR:
            r = lo + (hi - lo) * (0.5 * n_mid + 0.5 * n_fine)
            height[m] = hp[m] * 1.70              # follow the painted strands
        elif zid == BONE:
            r = lo + (hi - lo) * (0.5 * n_mid + 0.5 * crack)
            height[m] = hp[m] * 0.35 + (crack[m] - 0.5) * 0.28
        elif zid == EYE:
            r = np.full(shape, (lo + hi) * 0.5, np.float32)
            height[m] = 0.0
        else:
            r = lo + (hi - lo) * (0.5 * n_mid + 0.5 * n_fine)

        rough[m] = np.clip(r[m], 0.02, 1.0)
        metal[m] = met
        sss[m] = ss

    # --- edge wear. Curvature from the rasterized surface normal: convex texels
    # are the ones a belt buckle or a pauldron rim actually rubs bare, so they
    # get lighter and smoother. §7 asks for exactly this.
    nz = nrmmap / np.maximum(np.linalg.norm(nrmmap, axis=-1, keepdims=True), 1e-6)
    curv = np.zeros(shape, np.float32)
    for ax in range(3):
        c = nz[..., ax]
        curv += (c - T.box_blur(c, 4))
    curv = np.clip(curv * 6.0, -1.0, 1.0)
    convex = np.clip(curv, 0.0, 1.0) * (T.box_blur(n_fine, 1) * 0.5 + 0.5)

    wearable = (zone == METAL) | (zone == LEATHER)
    rough = np.where(wearable, rough - convex * 0.28, rough)
    # Cavities hold grime and read rougher.
    concave = np.clip(-curv, 0.0, 1.0)
    rough = np.where(cov, rough + concave * 0.12, rough)
    rough = np.clip(rough, 0.03, 1.0)

    # --- albedo.
    #
    # The generator paints for a flat-lit turnaround, so its values are far too
    # bright to be albedo: measured skin came back at 0.65 *linear*, against ~0.44
    # for real skin, which is why the first lit pass blew the face to porcelain.
    # Correct that in linear space, per zone, then re-encode.
    lin = T.srgb_to_linear(alb)

    # Per-channel white balance onto measured real-world albedo. Scaling the zone
    # mean onto a target rather than applying a flat gain also fixes hue: the
    # generator's skin is far more orange than flesh (R:G:B of 1:0.63:0.43 against
    # roughly 1:0.70:0.57), and a scalar gain would keep it that way.
    targets = ALBEDO_TARGETS.get(preset, {})
    gain3 = np.ones(shape + (3,), np.float32)
    for zid, target in targets.items():
        m = zone == zid
        if m.sum() < 500:
            continue
        cur = lin[m].mean(axis=0)
        g = np.clip(np.array(target, np.float32) / np.maximum(cur, 1e-4), 0.20, 1.05)
        gain3[m] = g
    lin *= gain3

    w3 = (convex * wearable.astype(np.float32) * 0.35)[..., None]
    lin = lin * (1.0 - w3) + w3 * np.array([0.36, 0.34, 0.31], np.float32)
    lin *= (1.0 - concave[..., None] * 0.20)
    # No pure black / pure white albedo (§7).
    lin = np.clip(lin, 0.0035, 0.80)
    out_alb = T.linear_to_srgb(lin)

    # --- normal. Slope is per-zone: skin gets pore-scale relief you have to
    # lean in to see, leather gets real cracks. A single global strength is what
    # turned the first pass into crumpled foil.
    slope = np.full(shape, 0.30, np.float32)
    for zid, s in ((SKIN, 0.30), (HAIR, 0.62), (LEATHER, 0.50), (METAL, 0.22),
                   (CLOTH, 0.34), (EYE, 0.02), (BONE, 0.34), (OTHER, 0.22)):
        slope[zone == zid] = s

    hx, hy = T.height_gradient(height)
    nrm = T.normal_from_gradient(hx, hy, slope)
    mx, my = T.height_gradient((n_fine - 0.5) * 0.6 + (pores - 0.5) * 0.4)
    micro = T.normal_from_gradient(mx, my, slope * 0.35)
    nrm = T.blend_normals(nrm, micro, 0.5)

    # --- cavity / AO
    ao = np.clip(1.0 - concave * 0.55 - np.clip(-hp, 0, 1) * 0.35, 0.25, 1.0)
    ao = T.box_blur(ao, 1)

    # --- seam bleed so mips do not drag OTHER-zone values into a silhouette
    fill = ~cov
    for _ in range(3):
        for arr in (out_alb, nrm):
            for ax in (0, 1):
                for d in (1, -1):
                    sh = np.roll(arr, d, ax)
                    arr[fill] = sh[fill]
        for name, arr in (("r", rough), ("m", metal), ("s", sss), ("a", ao)):
            for ax in (0, 1):
                for d in (1, -1):
                    sh = np.roll(arr, d, ax)
                    arr[fill] = sh[fill]

    # --- masked rim + backlight.
    #
    # Godot's rim and backlight are per-material scalars, but both accept a
    # texture, so the zone map can hand them to hair and ear-thin skin only.
    # Hair that does not transmit light at its edges reads as a moulded shell no
    # matter how good the strand normal is (ART_BIBLE §8), and a global rim would
    # put a fresnel halo on the leather too.
    hair_m = (zone == HAIR).astype(np.float32)
    skin_m = (zone == SKIN).astype(np.float32)
    hair_s = T.box_blur(hair_m, 2)
    rim_tex = np.stack([
        np.clip(hair_s * 0.45, 0.0, 1.0),                      # R: rim strength
        np.clip(hair_s * 0.60, 0.0, 1.0),                      # G: rim tint
        np.zeros(shape, np.float32),
    ], -1)
    warm = np.array([0.55, 0.47, 0.40], np.float32)
    back_tex = hair_s[..., None] * warm * 0.22

    out = {
        "albedo": out_alb,
        "normal": nrm,
        "rough": rough,
        "metal": metal,
        "sss": sss,
        "ao": ao,
        "rim": rim_tex,
        "backlight": np.clip(back_tex, 0.0, 1.0),
    }

    # --- draugr emission. ART_BIBLE §9 wants glowing sockets and cracks: they
    # read against volumetric fog and give the bloom pass something to catch.
    if preset == "zombie":
        py = posmap[..., 1]
        pz = posmap[..., 2]
        px = np.abs(posmap[..., 0])
        # Tight box around the eye sockets. The whole atlas is dark, so a bare
        # luminance test lights up half the character.
        socket = ((T.luminance(alb) < 0.11) & (py > 1.62) & (py < 1.80)
                  & (pz > 0.03) & (px < 0.085) & cov)
        glow = np.clip(T.box_blur(socket.astype(np.float32), 2) * 1.8, 0.0, 1.0)

        # Hairline rune fractures: only the sharpest crease of the ridged field,
        # gated again by a sparse low-frequency mask so they cluster.
        vein = np.clip(1.0 - crack * 34.0, 0.0, 1.0)
        vein *= np.clip((T.fbm(shape, 12, 3, 91) - 0.62) * 8.0, 0.0, 1.0)
        vein *= ((zone == SKIN) | (zone == BONE)).astype(np.float32)
        vein = T.box_blur(vein, 1) * 0.5

        cold = np.array([0.35, 0.72, 1.00], np.float32)
        em = glow[..., None] * cold + vein[..., None] * cold * 0.55
        out["emission"] = np.clip(em, 0.0, 1.0)
        # Emissive texels must not also be lit as dull matte hide.
        out["rough"] = np.clip(rough - glow * 0.25, 0.03, 1.0)

    return out


# ----------------------------------------------------------------------- main

def main() -> None:
    src, out_dir, preset = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)
    g = Glb(src)
    p = g.primitive()

    tmp = os.path.join(out_dir, "_albedo_src.png")
    imgs = g.dump_images(os.path.join(out_dir, "_src"))
    alb = T.load_rgb(imgs[0], (SIZE, SIZE))

    print(f"[{preset}] rasterizing {len(p['INDICES'])} tris into {SIZE}^2 UV space...")
    maps, cov = rasterize_uv(p["TEXCOORD_0"], p["INDICES"],
                             {"pos": p["POSITION"], "nrm": p["NORMAL"]}, SIZE)
    posmap, nrmmap = maps["pos"], maps["nrm"]
    print(f"[{preset}] atlas coverage {100.0 * cov.mean():.1f}%")

    hsv = T.rgb_to_hsv(alb)
    zone = classify(alb, hsv, posmap, cov, preset)
    counts = {ZONE_NAMES[i]: float((zone == i)[cov].mean()) for i in range(8)}
    print(f"[{preset}] zones " + " ".join(f"{k}={v*100:.1f}%" for k, v in counts.items()))

    T.save_rgb(os.path.join(out_dir, "_zones_debug.png"), ZONE_DEBUG[zone])

    res = author(alb, zone, posmap, nrmmap, cov, preset)
    T.save_rgb(os.path.join(out_dir, "albedo.png"), res["albedo"])
    T.save_rgb(os.path.join(out_dir, "normal.png"), res["normal"])
    T.save_gray(os.path.join(out_dir, "roughness.png"), res["rough"])
    T.save_gray(os.path.join(out_dir, "metallic.png"), res["metal"])
    T.save_gray(os.path.join(out_dir, "sss.png"), res["sss"])
    T.save_gray(os.path.join(out_dir, "ao.png"), res["ao"])
    T.save_gray(os.path.join(out_dir, "hair_mask.png"), (zone == HAIR).astype(np.float32))
    T.save_rgb(os.path.join(out_dir, "rim.png"), res["rim"])
    T.save_rgb(os.path.join(out_dir, "backlight.png"), res["backlight"])
    if "emission" in res:
        T.save_rgb(os.path.join(out_dir, "emission.png"), res["emission"])

    # Eye cluster centroids, in metres, for Blender to place cornea geometry.
    eyes = []
    if (zone == EYE).any():
        ys, xs = np.nonzero(zone == EYE)
        pts = posmap[ys, xs]
        pts = pts[pts[:, 1] > 1.4]
        if len(pts) > 40:
            for sign in (-1.0, 1.0):
                side = pts[np.sign(pts[:, 0]) == sign]
                if len(side) > 20:
                    c = np.median(side, axis=0)
                    eyes.append([float(c[0]), float(c[1]), float(c[2])])
    stats = {
        "preset": preset,
        "coverage": float(cov.mean()),
        "zones": counts,
        "eyes": eyes,
        "bbox": [p["POSITION"].min(0).tolist(), p["POSITION"].max(0).tolist()],
    }
    json.dump(stats, open(os.path.join(out_dir, "analysis.json"), "w"), indent=2)
    print(f"[{preset}] eyes found: {eyes}")
    if os.path.exists(tmp):
        os.remove(tmp)


if __name__ == "__main__":
    main()
