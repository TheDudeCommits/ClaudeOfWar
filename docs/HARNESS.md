# Build / Run / Capture Harness

Everything an agent needs to run the game and get frames out of it.

## Paths

```
ROOT=/Users/amir/Claude/ClaudeOfWar
GODOT=$ROOT/tools/Godot.app/Contents/MacOS/Godot
GAME=$ROOT/game
SHOTS=$ROOT/shots
REF=$ROOT/reference/Reference
```

## Run the game interactively

```bash
"$GODOT" --path "$GAME"
```

## Capture a frame (the important one)

Every scene includes a `CaptureRig` autoload. Capture is driven by **shot specs**
in `game/shots/<name>.json`, so a critic can reproduce exactly the same framing
that a previous round used, or match a reference plate.

```bash
"$GODOT" --path "$GAME" -- --shot=arena_ots --out="$SHOTS/round03/arena_ots.png"
```

A shot spec looks like:

```json
{
  "scene": "res://scenes/arena.tscn",
  "camera": { "pos": [2.1, 1.62, 3.4], "look_at": [1.2, 1.35, -2.0], "fov": 56 },
  "time_of_day": "cold_overcast",
  "pose": { "hero": "attack_heavy_impact", "t": 0.42 },
  "warmup_frames": 90,
  "resolution": [1920, 1080]
}
```

`warmup_frames` matters: SDFGI, volumetric fog, TAA and auto-exposure all need
time to converge. **Never capture before frame ~60** or the shot will be dark,
noisy, and unfairly bad. 90 is the safe default.

## Batch capture (what the critic runs)

```bash
python3 "$ROOT/tools/capture.py" --round 3 --shots arena_ots,hero_closeup,impact,group
```

Writes to `$SHOTS/round<N>/` and updates `state.json`.

## Blind comparison (what the critic must use)

```bash
python3 "$ROOT/tools/blind.py" --ours "$SHOTS/round3/arena_ots.png" --ref-pool "$REF"
```

This produces `$SHOTS/round3/blind_arena_ots.png`: our shot and a matched
reference plate placed side by side, **randomly left/right ordered**, with the
ordering key written to a separate file the critic must not read until after
recording a verdict. It also strips our HUD if `--no-hud` is passed, since the
reference plates have GoW HUD and ours must be judged on rendering, not UI.

## Progress page

```bash
python3 "$ROOT/tools/progress.py"          # regenerate progress/index.html
```
Served at http://localhost:8787 with a 10 s auto-refresh.

## Rules

- **Always capture at 1920×1080.** The reference plates are 16:9; anything else
  makes the blind test invalid.
- **Never hand-edit a screenshot.** If a shot needs different framing, change the
  shot spec and re-run. Post-processing a capture in Python is cheating and the
  critic will fail the round for it.
- Godot writes to `user://` by default; the capture rig takes absolute `--out`.
- Godot on macOS opens a real window. That's expected — Metal needs a surface.
  Runs are serialized by `tools/capture.py` to avoid window fights.
