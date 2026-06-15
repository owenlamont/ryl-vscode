# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Record the ryl-vscode feature-tour demos (demo/demo-<scenario>.{mp4,gif}).

Drives the montage (src/test/demo/montage.test.ts) through a real VS Code
instance once per scenario (YAML, then YAML-in-Markdown) and screen-captures
each to its own clip. Capture is OS-specific because ffmpeg's screen-grab device
differs per platform:

  Linux   : x11grab against a headless Xvfb display   (no window appears)
  Windows : gdigrab against the VS Code window         (a real window appears)
  macOS   : avfoundation against a display             (a real window appears)

Run with ``uv run scripts/record_demo.py`` (or ``npm run demo``). See the
"Demo recording" section of AGENTS.md for prerequisites (ffmpeg with the right
capture device, Xvfb on Linux, uv). Tunable via env: WIDTH/HEIGHT/FPS,
DISPLAY_NUM (Linux), RYL_DEMO_WINDOW (Windows window title),
RYL_DEMO_AVF_INPUT (macOS avfoundation input), FFMPEG/FFPROBE (binary paths).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

WIDTH = int(os.environ.get("WIDTH", "1280"))
HEIGHT = int(os.environ.get("HEIGHT", "800"))
FPS = int(os.environ.get("FPS", "15"))
DISPLAY_NUM = os.environ.get("DISPLAY_NUM", "99")
WINDOW_TITLE = os.environ.get("RYL_DEMO_WINDOW", "Extension Development Host")
OUT_DIR = Path("demo")
READY = Path(
    os.environ.get("RYL_DEMO_READY", Path(tempfile.gettempdir()) / "ryl-demo-ready")
)

# Each scenario is one montage run captured to its own clip (the montage reads
# RYL_DEMO_SCENARIO and performs just that scenario).
SCENARIOS = ["yaml", "markdown"]

# The ffmpeg capture device each platform needs, keyed by sys.platform, so we
# can fail early with a clear message instead of an opaque ffmpeg error.
CAPTURE_DEVICE = {"linux": "x11grab", "win32": "gdigrab", "darwin": "avfoundation"}
EVEN_DIMS = "scale=trunc(iw/2)*2:trunc(ih/2)*2"  # yuv420p rejects odd dimensions


def log(message: str) -> None:
    print(f"[record] {message}", flush=True)


def require(name: str) -> str:
    found = shutil.which(name)
    if not found:
        sys.exit(f"[record] required tool not found on PATH: {name}")
    return found


def has_device(ffmpeg: str, device: str) -> bool:
    listed = subprocess.run(
        [ffmpeg, "-hide_banner", "-devices"], capture_output=True, text=True
    )
    return device in listed.stdout + listed.stderr


def resolve_ffmpeg(device: str) -> str:
    """First ffmpeg that exists and supports the platform's capture device.

    On Linux the apt build at /usr/bin/ffmpeg is tried last because a pixi/conda
    ffmpeg often shadows it on PATH yet lacks x11grab.
    """
    candidates = [os.environ.get("FFMPEG"), shutil.which("ffmpeg")]
    if sys.platform == "linux":
        candidates.append("/usr/bin/ffmpeg")
    tried: list[str] = []
    for candidate in candidates:
        exe = (
            candidate
            if candidate and Path(candidate).exists()
            else shutil.which(candidate or "")
        )
        if not exe or exe in tried:
            continue
        tried.append(exe)
        if has_device(exe, device):
            return exe
    sys.exit(
        f"[record] no ffmpeg with the '{device}' capture device "
        f"(tried: {', '.join(tried) or 'none'}). Install one or set FFMPEG; "
        f"verify with `ffmpeg -devices`."
    )


def resolve_ffprobe() -> str:
    for candidate in (
        os.environ.get("FFPROBE"),
        shutil.which("ffprobe"),
        "/usr/bin/ffprobe",
    ):
        if candidate and Path(candidate).exists():
            return candidate
    return require("ffprobe")


def capture_command(ffmpeg: str, device: str, raw: Path) -> list[str]:
    base = [ffmpeg, "-y", "-loglevel", "warning"]
    encode = [
        "-codec:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        str(raw),
    ]
    if device == "x11grab":
        # Xvfb is exactly WIDTHxHEIGHT, so the frame is already even-sized.
        return [
            *base, "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{WIDTH}x{HEIGHT}",
            "-framerate", str(FPS), "-i", f":{DISPLAY_NUM}", *encode,
        ]  # fmt: skip
    if device == "gdigrab":
        # Capture just the VS Code window; its size is whatever VS Code opened at.
        return [
            *base, "-f", "gdigrab", "-draw_mouse", "0", "-framerate", str(FPS),
            "-i", f"title={WINDOW_TITLE}", "-vf", EVEN_DIMS, *encode,
        ]  # fmt: skip
    # avfoundation captures a whole display (no per-window capture); the input
    # index is machine-specific, hence the env override.
    avf_input = os.environ.get("RYL_DEMO_AVF_INPUT", "Capture screen 0")
    return [
        *base, "-f", "avfoundation", "-framerate", str(FPS),
        "-i", avf_input, "-vf", EVEN_DIMS, *encode,
    ]  # fmt: skip


def terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def stop_ffmpeg(proc: subprocess.Popen) -> None:
    # 'q' on stdin is ffmpeg's portable graceful stop (no SIGINT, which Windows
    # lacks), so the mp4 is finalised cleanly on every platform.
    try:
        if proc.stdin:
            proc.stdin.write(b"q")
            proc.stdin.flush()
    except OSError:
        pass
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        terminate(proc)


def trim(ffmpeg: str, ffprobe: str, raw: Path, out_mp4: Path) -> None:
    """Drop leading/trailing black (startup paint, teardown) via blackdetect."""
    log("trimming leading/trailing black")
    probe = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(raw)],
        capture_output=True, text=True,
    ).stdout.strip()  # fmt: skip
    duration = float(probe) if probe else 0.0
    detect = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(raw), "-vf", "blackdetect=d=0.4:pix_th=0.10",
         "-an", "-f", "null", "-"],
        capture_output=True, text=True,
    )  # fmt: skip
    intervals = [
        (float(start), float(end))
        for start, end in re.findall(
            r"black_start:([0-9.]+) black_end:([0-9.]+)", detect.stderr
        )
    ]
    lead, trail = 0.0, duration
    for start, end in intervals:
        if start <= 0.6:  # leading black: skip past it
            lead = max(lead, end)
        if duration and end >= duration - 0.6:  # trailing black: stop before it
            trail = min(trail, start)
    if not duration or trail <= lead:
        lead, trail = 0.0, duration
    keep = max(0.1, round(trail - lead, 2))
    log(f"content window: {lead:.2f}s -> {trail:.2f}s ({keep}s of {duration}s)")
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "warning", "-ss", f"{lead:.2f}", "-t", str(keep),
         "-i", str(raw), "-codec:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         str(out_mp4)],
        check=True,
    )  # fmt: skip


def encode_gif(ffmpeg: str, mp4: Path, gif: Path, palette: Path) -> None:
    log("encoding gif")
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "warning", "-i", str(mp4),
         "-vf", "fps=12,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff",
         "-update", "1", str(palette)],
        check=True,
    )  # fmt: skip
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "warning", "-i", str(mp4), "-i", str(palette),
         "-lavfi", "fps=12,scale=960:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer",
         str(gif)],
        check=True,
    )  # fmt: skip


def record_one(
    scenario: str,
    env: dict[str, str],
    ffmpeg: str,
    ffprobe: str,
    device: str,
    npx: str,
    procs: list[subprocess.Popen],
) -> int:
    """Run the montage for one scenario and capture it to demo/demo-<scenario>.*."""
    log(f"=== scenario: {scenario} ===")
    run_env = {**env, "RYL_DEMO_SCENARIO": scenario}
    READY.unlink(missing_ok=True)
    log("launching montage (waiting for workbench-ready signal)")
    montage = subprocess.Popen(
        [npx, "vscode-test", "--config", ".vscode-test.demo.mjs"], env=run_env
    )
    procs.append(montage)

    # Start capture only once the montage signals the workbench is clean, so the
    # recording opens on a tidy editor (no startup/welcome screen).
    for _ in range(240):  # up to ~120s
        if READY.exists() or montage.poll() is not None:
            break
        time.sleep(0.5)

    raw = OUT_DIR / f"raw-{scenario}.mp4"
    log(f"starting ffmpeg {device}")
    ffmpeg_proc = subprocess.Popen(
        capture_command(ffmpeg, device, raw), stdin=subprocess.PIPE
    )
    procs.append(ffmpeg_proc)

    status = montage.wait()
    time.sleep(0.3)  # let the last frame land before stopping
    stop_ffmpeg(ffmpeg_proc)

    if not raw.exists() or raw.stat().st_size == 0:
        sys.exit(
            "[record] capture produced no video (did ffmpeg find the display/window?)"
        )

    mp4 = OUT_DIR / f"demo-{scenario}.mp4"
    gif = OUT_DIR / f"demo-{scenario}.gif"
    trim(ffmpeg, ffprobe, raw, mp4)
    encode_gif(ffmpeg, mp4, gif, OUT_DIR / f"palette-{scenario}.png")
    log(
        f"montage exit: {status}; wrote {mp4} ({mp4.stat().st_size // 1024} KiB), "
        f"{gif} ({gif.stat().st_size // 1024} KiB)"
    )
    return status


def main() -> int:
    device = CAPTURE_DEVICE.get(sys.platform)
    if device is None:
        sys.exit(f"[record] unsupported platform: {sys.platform}")
    npm = require("npm")
    npx = require("npx")
    ffmpeg = resolve_ffmpeg(device)
    ffprobe = resolve_ffprobe()
    OUT_DIR.mkdir(exist_ok=True)

    procs: list[subprocess.Popen] = []
    try:
        log("compiling extension + montage")
        # Build both the test sources (out/, the montage) and the extension
        # bundle (dist/, what VS Code actually loads) so a client change is live.
        subprocess.run([npm, "run", "compile-tests"], check=True)
        subprocess.run([npm, "run", "compile"], check=True)

        env = dict(os.environ)
        env["RYL_DEMO_READY"] = str(READY)
        if device == "x11grab":
            log(f"starting Xvfb :{DISPLAY_NUM} ({WIDTH}x{HEIGHT})")
            xvfb = subprocess.Popen(
                [
                    "Xvfb",
                    f":{DISPLAY_NUM}",
                    "-screen",
                    "0",
                    f"{WIDTH}x{HEIGHT}x24",
                    "-nolisten",
                    "tcp",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            procs.append(xvfb)
            env["DISPLAY"] = f":{DISPLAY_NUM}"
            time.sleep(2)

        statuses = [
            record_one(scenario, env, ffmpeg, ffprobe, device, npx, procs)
            for scenario in SCENARIOS
        ]
        return max(statuses, default=0)
    finally:
        for proc in reversed(procs):
            terminate(proc)
        READY.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
