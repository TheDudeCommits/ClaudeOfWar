#!/bin/bash
# Rebuild -> reimport -> capture, in the one order that actually works.
#
# The trap this catches: running the project (`Godot --path game`) does NOT
# re-run the import pipeline, so a rebuilt .glb renders as the PREVIOUS build
# and every visual note you take is about stale geometry. The explicit
# `--headless --import` pass in the middle is mandatory after any asset change.
#
#   ./iterate.sh <round> [shots]           full rebuild
#   ./iterate.sh <round> [shots] --nogeo   skip Blender (materials/scene only)
set -e
ROOT=/Users/amir/Claude/ClaudeOfWar
ROUND=${1:-1}
SHOTS=${2:-arena_estab,arena_ots}

if [[ "$*" != *--nogeo* ]]; then
  echo "== blender build =="
  /opt/homebrew/bin/blender --background \
    --python "$ROOT/game/assets/arena/build/build_arena.py" 2>&1 \
    | grep -E "verts|!!|not valid|Traceback|Error"
fi

echo "== materials =="
python3 "$ROOT/game/assets/arena/build/gen_materials.py" > /dev/null

echo "== godot import =="
"$ROOT/tools/Godot.app/Contents/MacOS/Godot" --headless --path "$ROOT/game" \
  --import > /dev/null 2>&1 || true

echo "== capture round $ROUND =="
python3 "$ROOT/tools/capture.py" --round "$ROUND" --shots "$SHOTS"
