# Shared rules for every ClaudeOfWar agent

Read `docs/ART_BIBLE.md` and `docs/HARNESS.md` first. They are the spec.

## Absolute rules

1. **Stay inside your owned directories.** Listed in your task prompt. Touching
   another agent's files causes lost work — another agent is editing them right now.
2. **Never edit `game/project.godot`.** The orchestrator owns it. If you need a
   project setting changed, say so in your final report.
3. **Never hand-edit or post-process a capture.** Screenshots come out of the
   engine or they don't count. Compositing, denoising, or "touching up" a PNG in
   Python is fraud and fails the whole piece.
4. **Verify before you report.** Run `tools/capture.py` and actually look at the
   PNG with the Read tool before claiming anything works. Reporting a shot you
   have not viewed is the single most common failure mode.
5. **Commit your work** with `git add <your dirs> && git commit`. Do not
   `git add -A` (you'd sweep up other agents' in-flight edits). Do not push.

## Engine notes that will bite you

- Godot 4.7, Forward+, Metal on Apple M2. `--headless` cannot render; capture
  runs open a real window. That is expected.
- `tools/capture.py` holds an exclusive lock. Concurrent captures serialize —
  if a capture seems to hang for a minute, another agent is mid-shot. Wait.
- SDFGI/TAA/volumetric fog/auto-exposure need ~60-90 frames to converge.
  `warmup_frames` below 60 gives a dark noisy frame. Don't lower it to save time.
- `.tscn` files are text. Writing them by hand is fine and often faster than the
  editor, but `load_steps` must be ≥ the number of resources or Godot errors.
- Import: new assets under `game/assets/` need one Godot run to import before
  they can be referenced. `tools/capture.py` triggers this naturally.
- GDScript is statically typed here. Use explicit types; `Variant` inference
  errors are a common build break.

## Asset generation

Higgsfield MCP is available for image and 3D generation and the credit budget is
small (~164 credits total for the whole project). Preflight with `get_cost:true`
before any generate call, and spend only on things that genuinely cannot be
built procedurally. Blender 5.2 is installed at `/opt/homebrew/bin/blender` and
is free — prefer it for anything geometric, and for all retopo/rig/bake/export.
Export to `.glb`.

## Definition of done for a builder

- The piece renders in-engine at 1920×1080.
- Shot specs exist in `game/shots/` for the framings your critic will need.
- You have viewed every capture yourself and it is free of obvious defects
  (black frame, missing texture, z-fighting, shadow acne, clipping).
- Your final report names what you built, what you could not get to, and the
  one thing you think is still weakest. Be honest — the critic will find it
  anyway, and a builder who hides a flaw wastes a whole round.

## Definition of done for a critic

See your task prompt. The short version: run the game yourself, capture from
framings matched to the reference plate, build the blind plate, record a verdict
BEFORE reading the answer key, and name exactly one biggest gap.

"Good for a web game", "good for a solo dev", "impressive given the constraints"
are all failing grades. The only passing grade is: *placed beside a God of War
Ragnarök screenshot, a hostile judge picks ours as the more expensive-looking
image, or genuinely cannot tell.*
