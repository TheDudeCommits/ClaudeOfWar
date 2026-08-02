# Build / Run / Capture Harness

Everything an agent needs to run the game and get frames out of it.
Stack: **Three.js r185** + Vite + `postprocessing` 6.39 + N8AO, WebGL2 on
ANGLE-Metal. (An earlier Godot build existed and has been deleted; ignore any
reference to `.tscn`, `.gd`, or `tools/Godot.app`.)

## Paths

```
ROOT=/Users/amir/Claude/ClaudeOfWar
WEB=$ROOT/web
SHOTS=$ROOT/shots
REF=$ROOT/reference/Reference
LIVE=https://thedudecommits.github.io/ClaudeOfWar/
```

## Run

```bash
cd $ROOT/web && npm run dev      # http://localhost:5173
```
Check it is up before capturing:
`curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/`

Quality preset: append `?q=medium` (Performance, default) or `?q=high`
(Fidelity). Capture runs inherit whatever the preset resolves to.

## Capture

Shot specs live in `web/public/shots/*.json` and own the camera, time of day and
actor placement, so a framing is reproducible across rounds.

```bash
cd $ROOT/web && node capture.mjs --round 20 --shots arena_ots,char_hero_closeup
```
Writes 1920×1080 PNGs to `$SHOTS/round20/`. Spec format:

```json
{ "time_of_day": "cold_overcast",
  "camera": { "rig": "ots", "fov": 56, "distance": 2.45, "pitch": -8 },
  "actors": { "hero":   { "pos": [1.3, 0, 1.6],  "rot_y": 195 },
              "zombie": { "pos": [-1.2, 0, -3.4], "rot_y": 20 } },
  "settle": 60 }
```
`"camera": {"rig":"ots"}` frames with the real gameplay camera. Use explicit
`{"pos":[..],"look_at":[..],"fov":n}` only when matching a reference plate.

`settle` matters: bloom, AO denoise and the DOF CoC need real frames to
converge. Below ~40 the shot comes out noisy. 60 is the default.

Gameplay does **not** boot in capture mode (`?shot=` present), so captures stay
deterministic.

## Measure

```bash
python3 $ROOT/tools/refstats.py $SHOTS/round20/arena_ots.png     # grade gates
python3 $ROOT/tools/refstats.py $REF --summary                   # the bar
cd $ROOT/web && node perf.mjs --frames 150                       # frame times
```
`refstats` gates are defined in `docs/REF_STATS.md`. **Metrics are necessary,
not sufficient** — a completely corrupted frame once scored 5/6 gates "ok".
Always open the PNG with the Read tool as well.

## Blind test

```bash
python3 $ROOT/tools/blind.py --ours <ours.png> --ref "$REF/Gow5.jpg" \
  --out $SHOTS/round20/blind.png
```
Writes the two side by side at identical size in random L/R order, with the
answer key in a separate `*.KEY.json`. **Record a verdict before opening the
key.**

## Shader changes — read this

Three r185 removed `perturbNormal2Arb`. Inside `#include <normal_fragment_maps>`
use `tbn`, which is always defined under `USE_NORMALMAP_TANGENTSPACE`.

`#include <common>` is emitted **before** `<uv_pars_fragment>`, so a helper
function declared there cannot see `vMapUv`. Declare uniforms at `<common>` and
inline the sampling at each use site.

After ANY shader edit, assert zero compile errors — launch puppeteer and count
console messages matching `/Shader Error|not compiled|INVALID_OP/`. A broken
injection makes materials look merely "flat"; nothing visibly breaks, and this
project has twice shipped 260+ silent errors that way.

## Colour space

The grade shader runs on display-**linear** values; the frame is sRGB-encoded
afterwards. A lift of `L` in the shader measures as `L^(1/2.2)` in
`refstats.py`. Solve grade constants against the measured frame, not on paper.

## Deploy

```bash
cd $ROOT/web && COW_BASE=/ClaudeOfWar/ npm run build
rm -rf /tmp/ghp && mkdir -p /tmp/ghp && cp -R $ROOT/web/dist/. /tmp/ghp/
touch /tmp/ghp/.nojekyll && cd /tmp/ghp && git init -q && git add -A \
  && git commit -qm deploy \
  && git push -qf https://github.com/TheDudeCommits/ClaudeOfWar.git HEAD:gh-pages
```
Deploy from a clean temp tree — an orphan branch in the repo sweeps in
`node_modules` and gets rejected. All runtime asset URLs must go through
`src/core/paths.js`.

## Progress page

```bash
python3 $ROOT/tools/progress.py     # regenerates progress/index.html from state.json
```
