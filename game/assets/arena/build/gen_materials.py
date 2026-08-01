#!/usr/bin/env python3
"""Emit the arena's ShaderMaterial .tres files.

One tuned instance of surface.gdshader per material, plus the two-layer
ground material. Keeping this as a generator means a look tweak is a one-line
edit here rather than eleven hand-edited resource files.

    python3 gen_materials.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.dirname(HERE)
OUT = os.path.join(ASSETS, "materials")
TEX = "res://assets/arena/textures/"
os.makedirs(OUT, exist_ok=True)

# name: uv_scale, normal_strength, detail_scale, detail_strength, macro_strength,
#       rough_mul, rough_add, metal_mul, ao_affect, specular, extra
SURFACES = {
    # walls, rubble, cliffs - the dominant surface in frame
    "stone": dict(uv_scale=1.0, normal_strength=1.05, detail_scale=8.0,
                  detail_strength=0.55, macro_strength=0.42,
                  roughness_mul=1.0, roughness_add=0.0, ao_affect=0.32),
    "timber": dict(uv_scale=1.0, normal_strength=1.10, detail_scale=9.0,
                   detail_strength=0.45, macro_strength=0.35,
                   roughness_mul=0.98, ao_affect=0.30, specular_v=0.42),
    "plank": dict(uv_scale=1.0, normal_strength=0.95, detail_scale=10.0,
                  detail_strength=0.40, macro_strength=0.30,
                  roughness_mul=0.96, metallic_mul=1.0, ao_affect=0.28,
                  specular_v=0.45),
    "iron": dict(uv_scale=1.0, normal_strength=0.90, detail_scale=12.0,
                 detail_strength=0.35, macro_strength=0.22,
                 roughness_mul=0.95, metallic_mul=1.0, ao_affect=0.22,
                 specular_v=0.55),
    "cloth": dict(uv_scale=1.0, normal_strength=0.80, detail_scale=6.0,
                  detail_strength=0.30, macro_strength=0.25,
                  roughness_mul=1.0, ao_affect=0.35, specular_v=0.35,
                  backlight_v=0.16,
                  sss_tint=(0.62, 0.30, 0.22)),
    "snow": dict(uv_scale=1.0, normal_strength=0.85, detail_scale=11.0,
                 detail_strength=0.50, macro_strength=0.30,
                 roughness_mul=1.0, ao_affect=0.20, specular_v=0.5,
                 sss=0.35, sss_tint=(0.78, 0.86, 1.0)),
    "rope": dict(uv_scale=1.0, normal_strength=1.0, detail_scale=5.0,
                 detail_strength=0.30, macro_strength=0.15, ao_affect=0.30),
    "thatch": dict(uv_scale=1.0, normal_strength=1.15, detail_scale=6.0,
                   detail_strength=0.40, macro_strength=0.38,
                   roughness_mul=1.0, ao_affect=0.36, specular_v=0.30),
    "bark": dict(uv_scale=1.0, normal_strength=1.25, detail_scale=8.0,
                 detail_strength=0.45, macro_strength=0.32,
                 roughness_mul=1.0, ao_affect=0.34, specular_v=0.35),
    "dirt": dict(tint=(1.30, 1.24, 1.16), uv_scale=1.5, normal_strength=1.05, detail_scale=9.0,
                 detail_strength=0.45, macro_strength=0.35,
                 roughness_mul=1.0, ao_affect=0.30),
}

FLOATS = ("uv_scale", "normal_strength", "detail_scale", "detail_strength",
          "macro_scale", "macro_strength", "roughness_mul", "roughness_add",
          "metallic_mul", "ao_affect", "specular_v", "vcol_strength", "sss",
          "backlight_v")


def ext(idx, path, typ="Texture2D"):
    return f'[ext_resource type="{typ}" path="{path}" id="{idx}"]'


def write_surface(name, cfg):
    tex = [(f"{name}_albedo.png", "albedo_tex"),
           (f"{name}_normal.png", "normal_tex"),
           (f"{name}_orm.png", "orm_tex"),
           ("detail_normal.png", "detail_normal_tex"),
           ("macro_variation.png", "macro_tex")]
    lines = []
    steps = len(tex) + 1
    lines.append(f'[gd_resource type="ShaderMaterial" load_steps={steps + 1} format=3]')
    lines.append("")
    lines.append(ext("shd", "res://assets/arena/materials/surface.gdshader", "Shader"))
    for i, (f, _) in enumerate(tex):
        lines.append(ext(f"t{i}", TEX + f))
    lines.append("")
    lines.append("[resource]")
    lines.append('shader = ExtResource("shd")')
    for i, (_, u) in enumerate(tex):
        lines.append(f'shader_parameter/{u} = ExtResource("t{i}")')
    tint = cfg.get("tint", (1.0, 1.0, 1.0))
    lines.append(f"shader_parameter/tint = Color({tint[0]}, {tint[1]}, {tint[2]}, 1)")
    st = cfg.get("sss_tint", (0.85, 0.9, 1.0))
    lines.append(f"shader_parameter/sss_tint = Color({st[0]}, {st[1]}, {st[2]}, 1)")
    for k in FLOATS:
        v = cfg.get(k, None)
        if v is None:
            continue
        lines.append(f"shader_parameter/{k} = {float(v)}")
    path = os.path.join(OUT, name + ".tres")
    open(path, "w").write("\n".join(lines) + "\n")
    return path


def write_ground():
    tex = [("rock_albedo.png", "rock_alb"), ("rock_normal.png", "rock_nrm"),
           ("rock_orm.png", "rock_orm"), ("snow_albedo.png", "snow_alb"),
           ("snow_normal.png", "snow_nrm"), ("snow_orm.png", "snow_orm"),
           ("detail_normal.png", "detail_normal_tex"),
           ("macro_variation.png", "macro_tex")]
    p = dict(rock_uv=1.75, snow_uv=1.05, detail_scale=9.0, detail_strength=0.45,
             macro_scale=0.055, macro_strength=0.40, snow_bias=0.09,
             blend_sharp=0.19, cavity_bias=0.45, ao_affect=0.30, snow_sss=0.32)
    lines = [f'[gd_resource type="ShaderMaterial" load_steps={len(tex) + 2} format=3]', ""]
    lines.append(ext("shd", "res://assets/arena/materials/ground.gdshader", "Shader"))
    for i, (f, _) in enumerate(tex):
        lines.append(ext(f"t{i}", TEX + f))
    lines += ["", "[resource]", 'shader = ExtResource("shd")']
    for i, (_, u) in enumerate(tex):
        lines.append(f'shader_parameter/{u} = ExtResource("t{i}")')
    lines.append("shader_parameter/rock_tint = Color(1, 1, 1, 1)")
    lines.append("shader_parameter/snow_tint = Color(1, 1, 1, 1)")
    for k, v in p.items():
        lines.append(f"shader_parameter/{k} = {float(v)}")
    path = os.path.join(OUT, "ground.tres")
    open(path, "w").write("\n".join(lines) + "\n")
    return path


if __name__ == "__main__":
    for n, c in SURFACES.items():
        print("  ", write_surface(n, c))
    print("  ", write_ground())
