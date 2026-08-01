"""Minimal glTF-binary reader.

We only need vertex arrays, UVs and the embedded textures out of the Meshy
output, and pulling in a full glTF library for that is not worth it. Blender is
used for anything that *edits* the mesh; this module is read-only analysis.
"""
from __future__ import annotations

import json
import struct

import numpy as np

_COMP = {
    5120: ("b", 1, np.int8),
    5121: ("B", 1, np.uint8),
    5122: ("h", 2, np.int16),
    5123: ("H", 2, np.uint16),
    5125: ("I", 4, np.uint32),
    5126: ("f", 4, np.float32),
}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Glb:
    def __init__(self, path: str):
        raw = open(path, "rb").read()
        assert raw[:4] == b"glTF", "not a binary glTF"
        off, chunks = 12, {}
        while off < len(raw):
            ln, ty = struct.unpack_from("<II", raw, off)
            off += 8
            chunks[ty] = raw[off:off + ln]
            off += ln
        self.json = json.loads(chunks[0x4E4F534A].decode("utf8"))
        self.bin = chunks.get(0x004E4942, b"")

    # -------------------------------------------------------------- accessors

    def accessor(self, idx: int) -> np.ndarray:
        a = self.json["accessors"][idx]
        n = _NCOMP[a["type"]]
        fmt, size, dt = _COMP[a["componentType"]]
        count = a["count"]
        if "bufferView" not in a:
            return np.zeros((count, n), dt)
        bv = self.json["bufferViews"][a["bufferView"]]
        base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride") or (size * n)
        if stride == size * n:
            buf = np.frombuffer(self.bin, dt, count=count * n, offset=base)
            out = buf.reshape(count, n)
        else:                                        # interleaved
            out = np.empty((count, n), dt)
            for i in range(count):
                out[i] = np.frombuffer(self.bin, dt, count=n, offset=base + i * stride)
        if a.get("normalized") and dt != np.float32:
            info = np.iinfo(dt)
            out = out.astype(np.float32) / float(info.max)
        return out

    # ------------------------------------------------------------------ mesh

    def primitive(self, mesh: int = 0, prim: int = 0) -> dict:
        p = self.json["meshes"][mesh]["primitives"][prim]
        out = {"material": p.get("material")}
        for name, acc in p["attributes"].items():
            out[name] = self.accessor(acc)
        out["INDICES"] = self.accessor(p["indices"]).reshape(-1, 3).astype(np.int64)
        return out

    # -------------------------------------------------------------- textures

    def image_bytes(self, idx: int) -> bytes:
        im = self.json["images"][idx]
        bv = self.json["bufferViews"][im["bufferView"]]
        base = bv.get("byteOffset", 0)
        return self.bin[base:base + bv["byteLength"]]

    def dump_images(self, prefix: str) -> list[str]:
        out = []
        for i, im in enumerate(self.json.get("images", [])):
            ext = ".png" if "png" in im.get("mimeType", "") else ".jpg"
            p = f"{prefix}_{i}{ext}"
            open(p, "wb").write(self.image_bytes(i))
            out.append(p)
        return out


# ----------------------------------------------------------- UV rasterization

def rasterize_uv(uv: np.ndarray, tri: np.ndarray, attrs: dict[str, np.ndarray],
                 size: int) -> tuple[dict[str, np.ndarray], np.ndarray]:
    """Rasterize per-vertex attributes into UV space.

    Gives us, for every texel of the albedo atlas, the 3D point and normal it
    lands on. That is what lets material classification use *body position* and
    not only colour — "low saturation and high value" is hair on the skull and
    frost on a boot, and only the position map can tell those apart.

    Returns ({name: (size, size, n)}, coverage mask).
    """
    out = {k: np.zeros((size, size, v.shape[1]), np.float32) for k, v in attrs.items()}
    cov = np.zeros((size, size), bool)

    # UV origin is top-left in image space; glTF UV v runs down.
    px = uv[:, 0] * (size - 1)
    py = uv[:, 1] * (size - 1)

    for t in tri:
        x = px[t]
        y = py[t]
        x0 = max(int(np.floor(x.min())), 0)
        x1 = min(int(np.ceil(x.max())), size - 1)
        y0 = max(int(np.floor(y.min())), 0)
        y1 = min(int(np.ceil(y.max())), size - 1)
        if x1 < x0 or y1 < y0:
            continue
        # Skip atlas-wrapping degenerates rather than smearing them across UV.
        if (x1 - x0) > size // 3 or (y1 - y0) > size // 3:
            continue

        gx, gy = np.meshgrid(np.arange(x0, x1 + 1, dtype=np.float32),
                             np.arange(y0, y1 + 1, dtype=np.float32))
        d = ((y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2]))
        if abs(d) < 1e-9:
            continue
        w0 = ((y[1] - y[2]) * (gx - x[2]) + (x[2] - x[1]) * (gy - y[2])) / d
        w1 = ((y[2] - y[0]) * (gx - x[2]) + (x[0] - x[2]) * (gy - y[2])) / d
        w2 = 1.0 - w0 - w1
        m = (w0 >= -0.002) & (w1 >= -0.002) & (w2 >= -0.002)
        if not m.any():
            continue
        ys, xs = np.nonzero(m)
        ys = ys + y0
        xs = xs + x0
        a0 = w0[m][:, None]
        a1 = w1[m][:, None]
        a2 = w2[m][:, None]
        for k, v in attrs.items():
            out[k][ys, xs] = v[t[0]] * a0 + v[t[1]] * a1 + v[t[2]] * a2
        cov[ys, xs] = True
    return out, cov
