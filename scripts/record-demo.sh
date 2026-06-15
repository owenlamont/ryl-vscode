#!/usr/bin/env bash
# Record a screen-capture demo of the ryl extension on a headless Xvfb display.
# Drives the montage (src/test/demo) through a real VS Code instance and writes
# demo/demo.mp4 and demo/demo.gif. Requires Xvfb and an x11grab-capable ffmpeg
# (the apt build at /usr/bin/ffmpeg; the pixi ffmpeg lacks x11grab).
set -uo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
WIDTH="${WIDTH:-1280}"
HEIGHT="${HEIGHT:-800}"
FPS="${FPS:-15}"
FFMPEG="${FFMPEG:-/usr/bin/ffmpeg}"
OUT_DIR="demo"
mkdir -p "$OUT_DIR"

XVFB_PID=""
FFMPEG_PID=""
MONTAGE_PID=""
READY="${RYL_DEMO_READY:-/tmp/ryl-demo-ready}"
export RYL_DEMO_READY="$READY"
cleanup() {
  [ -n "$FFMPEG_PID" ] && kill -INT "$FFMPEG_PID" 2>/dev/null
  [ -n "$MONTAGE_PID" ] && kill "$MONTAGE_PID" 2>/dev/null
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null
  rm -f "$READY"
  wait 2>/dev/null
}
trap cleanup EXIT

echo "[record] compiling montage"
npm run compile-tests || exit 1

echo "[record] starting Xvfb :$DISPLAY_NUM (${WIDTH}x${HEIGHT})"
Xvfb ":$DISPLAY_NUM" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!
export DISPLAY=":$DISPLAY_NUM"
sleep 2

# Optional: maximise the VS Code window to fill the frame once it appears.
if command -v xdotool >/dev/null 2>&1; then
  (
    for _ in $(seq 1 30); do
      win=$(xdotool search --name "Visual Studio Code" 2>/dev/null | head -1)
      if [ -n "$win" ]; then
        xdotool windowsize "$win" "$WIDTH" "$HEIGHT" windowmove "$win" 0 0 2>/dev/null
        break
      fi
      sleep 1
    done
  ) &
fi

rm -f "$READY"
echo "[record] launching montage (waiting for workbench-ready signal)"
npx vscode-test --config .vscode-test.demo.mjs &
MONTAGE_PID=$!

# Start capture only once the montage signals the workbench is set up and
# clean, so the recording opens on a tidy editor (no startup/welcome screen).
for _ in $(seq 1 120); do
  [ -f "$READY" ] && break
  kill -0 "$MONTAGE_PID" 2>/dev/null || break
  sleep 0.5
done

echo "[record] starting ffmpeg x11grab"
"$FFMPEG" -y -loglevel warning -f x11grab -draw_mouse 0 \
  -video_size "${WIDTH}x${HEIGHT}" -framerate "$FPS" -i ":$DISPLAY_NUM" \
  -codec:v libx264 -preset veryfast -pix_fmt yuv420p "$OUT_DIR/raw.mp4" &
FFMPEG_PID=$!

wait "$MONTAGE_PID"
RUN_STATUS=$?
MONTAGE_PID=""

sleep 0.3
kill -INT "$FFMPEG_PID" 2>/dev/null
wait "$FFMPEG_PID" 2>/dev/null
FFMPEG_PID=""

echo "[record] trimming leading/trailing black"
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT_DIR/raw.mp4" 2>/dev/null)
read -r LEAD TRAIL < <(
  "$FFMPEG" -hide_banner -i "$OUT_DIR/raw.mp4" -vf blackdetect=d=0.4:pix_th=0.10 -an -f null - 2>&1 |
    DURATION="$DURATION" python3 -c '
import os, re, sys
dur = float(os.environ.get("DURATION") or 0.0)
data = sys.stdin.read()
intervals = [(float(a), float(b)) for a, b in re.findall(r"black_start:([0-9.]+) black_end:([0-9.]+)", data)]
lead, trail = 0.0, dur
for s, e in intervals:
    if s <= 0.6:                       # leading black: skip past it
        lead = max(lead, e)
    if dur and e >= dur - 0.6:         # trailing black: stop before it
        trail = min(trail, s)
if not dur or trail <= lead:
    lead, trail = 0.0, (dur or 0.0)
print(f"{lead:.2f} {trail:.2f}")
'
)
KEEP=$(python3 -c "print(round(max(0.1, ${TRAIL:-0} - ${LEAD:-0}), 2))")
echo "[record] content window: ${LEAD}s -> ${TRAIL}s (${KEEP}s of ${DURATION}s)"
"$FFMPEG" -y -loglevel warning -ss "${LEAD}" -t "${KEEP}" -i "$OUT_DIR/raw.mp4" \
  -codec:v libx264 -preset veryfast -pix_fmt yuv420p "$OUT_DIR/demo.mp4"

echo "[record] encoding gif"
"$FFMPEG" -y -loglevel warning -i "$OUT_DIR/demo.mp4" \
  -vf "fps=12,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" -update 1 "$OUT_DIR/palette.png"
"$FFMPEG" -y -loglevel warning -i "$OUT_DIR/demo.mp4" -i "$OUT_DIR/palette.png" \
  -lavfi "fps=12,scale=960:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer" "$OUT_DIR/demo.gif"

echo "[record] montage exit: $RUN_STATUS"
ls -lh "$OUT_DIR"/demo.mp4 "$OUT_DIR"/demo.gif 2>/dev/null
