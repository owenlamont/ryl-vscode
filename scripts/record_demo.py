#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.14"
# dependencies = ["typer"]
#
# [tool.uv]
# # One-week dependency cooldown (rolling): ignore releases newer than one week
# # before each run as a supply-chain-safety buffer. "1 week" is uv's documented
# # friendly-duration form ("1 week ago" is rejected by older uv).
# exclude-newer = "1 week"
# ///

"""Record the ryl-vscode feature-tour demos (``demo/demo-<scenario>.{mp4,gif}``).

Drives the montage (``src/test/demo/montage.test.ts``) through a real VS Code
instance once per scenario (YAML, then YAML-in-Markdown) and screen-captures each
to its own clip. Capture is OS-specific because ffmpeg's screen-grab device
differs per platform: ``x11grab`` against a headless Xvfb display on Linux,
``gdigrab`` against the VS Code window on Windows, and ``avfoundation`` against a
display on macOS (the latter two show a real window during the recording).

Demo-only: not shipped in the ``.vsix`` or run in CI. See the "Demo recording"
section of AGENTS.md for prerequisites (ffmpeg with the right capture device,
Xvfb on Linux, uv). Run ``--help`` for the tunable options.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Annotated, Final

import typer


OUT_DIR: Final = Path("demo")
# Each scenario is one montage run captured to its own clip; the montage reads
# the RYL_DEMO_SCENARIO env var (its only IPC) and performs just that scenario.
SCENARIOS: Final = ("yaml", "markdown")
# The ffmpeg capture device each platform needs, keyed by sys.platform, so we can
# fail early with a clear message instead of an opaque ffmpeg error.
CAPTURE_DEVICE: Final = {
    "linux": "x11grab",
    "win32": "gdigrab",
    "darwin": "avfoundation",
}
EVEN_DIMS: Final = "scale=trunc(iw/2)*2:trunc(ih/2)*2"  # yuv420p rejects odd dimensions


@dataclass(frozen=True)
class Settings:
    """Resolved recorder configuration for one invocation."""

    device: str
    ffmpeg: str
    ffprobe: str
    npx: str
    width: int
    height: int
    fps: int
    display_num: str
    window_title: str
    avf_input: str
    ready: Path


def log(message: str) -> None:
    print(f"[record] {message}", flush=True)


def fail(message: str) -> typer.Exit:
    """Print an error and return an Exit(1) for the caller to raise."""
    typer.echo(f"[record] {message}", err=True)
    return typer.Exit(code=1)


def require(name: str) -> str:
    found = shutil.which(name)
    if found is None:
        raise fail(f"required tool not found on PATH: {name}")
    return found


def has_device(ffmpeg: str, device: str) -> bool:
    listed = subprocess.run(
        [ffmpeg, "-hide_banner", "-devices"],
        capture_output=True,
        text=True,
        check=False,
    )
    return device in listed.stdout + listed.stderr


def resolve_ffmpeg(device: str, override: str | None) -> str:
    """First ffmpeg that exists and supports the platform's capture device.

    On Linux the apt build at /usr/bin/ffmpeg is tried last because a pixi/conda
    ffmpeg often shadows it on PATH yet lacks x11grab.
    """
    candidates = [override, shutil.which("ffmpeg")]
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
    raise fail(
        f"no ffmpeg with the '{device}' capture device "
        f"(tried: {', '.join(tried) or 'none'}). "
        f"Pass --ffmpeg, or install one; verify with `ffmpeg -devices`."
    )


def resolve_ffprobe(override: str | None) -> str:
    # Mirror resolve_ffmpeg: resolve a bare-name override via PATH (not only a
    # literal file), and gate the /usr/bin fallback to Linux.
    candidates = [override, shutil.which("ffprobe")]
    if sys.platform == "linux":
        candidates.append("/usr/bin/ffprobe")
    for candidate in candidates:
        exe = (
            candidate
            if candidate and Path(candidate).exists()
            else shutil.which(candidate or "")
        )
        if exe:
            return exe
    raise fail("ffprobe not found on PATH; pass --ffprobe")


def capture_command(settings: Settings, raw: Path) -> list[str]:
    base = [settings.ffmpeg, "-y", "-loglevel", "warning"]
    encode = [
        "-codec:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        str(raw),
    ]
    if settings.device == "x11grab":
        # Xvfb is exactly width x height, so the frame is already even-sized.
        return [
            *base,
            "-f",
            "x11grab",
            "-draw_mouse",
            "0",
            "-video_size",
            f"{settings.width}x{settings.height}",
            "-framerate",
            str(settings.fps),
            "-i",
            f":{settings.display_num}",
            *encode,
        ]
    if settings.device == "gdigrab":
        # Capture the VS Code window by title (the demo workspace pins
        # `window.title` to `--window-title`). UNVERIFIED on Windows: the Extension
        # Development Host may prefix the title, so the exact match can miss — if so,
        # set --window-title to the real title or switch this to `-i desktop`.
        return [
            *base,
            "-f",
            "gdigrab",
            "-draw_mouse",
            "0",
            "-framerate",
            str(settings.fps),
            "-i",
            f"title={settings.window_title}",
            "-vf",
            EVEN_DIMS,
            *encode,
        ]
    # avfoundation captures a whole display (no per-window capture); the input
    # index is machine-specific, hence the --avf-input option.
    return [
        *base,
        "-f",
        "avfoundation",
        "-framerate",
        str(settings.fps),
        "-i",
        settings.avf_input,
        "-vf",
        EVEN_DIMS,
        *encode,
    ]


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


def trim(settings: Settings, raw: Path, out_mp4: Path) -> None:
    """Drop leading/trailing black (startup paint, teardown) via blackdetect."""
    log("trimming leading/trailing black")
    probe = subprocess.run(
        [
            settings.ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            str(raw),
        ],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    duration = float(probe) if probe else 0.0
    detect = subprocess.run(
        [
            settings.ffmpeg,
            "-hide_banner",
            "-i",
            str(raw),
            "-vf",
            "blackdetect=d=0.4:pix_th=0.10",
            "-an",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
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
        [
            settings.ffmpeg,
            "-y",
            "-loglevel",
            "warning",
            "-ss",
            f"{lead:.2f}",
            "-t",
            str(keep),
            "-i",
            str(raw),
            "-codec:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            str(out_mp4),
        ],
        check=True,
    )


def encode_gif(settings: Settings, mp4: Path, gif: Path, palette: Path) -> None:
    log("encoding gif")
    subprocess.run(
        [
            settings.ffmpeg,
            "-y",
            "-loglevel",
            "warning",
            "-i",
            str(mp4),
            "-vf",
            "fps=12,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff",
            "-update",
            "1",
            str(palette),
        ],
        check=True,
    )
    subprocess.run(
        [
            settings.ffmpeg,
            "-y",
            "-loglevel",
            "warning",
            "-i",
            str(mp4),
            "-i",
            str(palette),
            "-lavfi",
            "fps=12,scale=960:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer",
            str(gif),
        ],
        check=True,
    )


def record_one(
    settings: Settings,
    scenario: str,
    env: dict[str, str],
    procs: list[subprocess.Popen],
) -> int:
    """Run the montage for one scenario and capture it to demo/demo-<scenario>.*."""
    log(f"=== scenario: {scenario} ===")
    run_env = {**env, "RYL_DEMO_SCENARIO": scenario}
    settings.ready.unlink(missing_ok=True)
    log("launching montage (waiting for workbench-ready signal)")
    montage = subprocess.Popen(
        [settings.npx, "vscode-test", "--config", ".vscode-test.demo.mjs"], env=run_env
    )
    procs.append(montage)

    # Start capture only once the montage signals the workbench is clean, so the
    # recording opens on a tidy editor (no startup/welcome screen).
    for _ in range(240):  # up to ~120s
        if settings.ready.exists() or montage.poll() is not None:
            break
        time.sleep(0.5)

    raw = OUT_DIR / f"raw-{scenario}.mp4"
    log(f"starting ffmpeg {settings.device}")
    ffmpeg_proc = subprocess.Popen(
        capture_command(settings, raw), stdin=subprocess.PIPE
    )
    procs.append(ffmpeg_proc)

    status = montage.wait()
    time.sleep(0.3)  # let the last frame land before stopping
    stop_ffmpeg(ffmpeg_proc)

    if not raw.exists() or raw.stat().st_size == 0:
        raise fail("capture produced no video (did ffmpeg find the display/window?)")

    mp4 = OUT_DIR / f"demo-{scenario}.mp4"
    gif = OUT_DIR / f"demo-{scenario}.gif"
    trim(settings, raw, mp4)
    encode_gif(settings, mp4, gif, OUT_DIR / f"palette-{scenario}.png")
    log(
        f"montage exit: {status}; wrote {mp4} ({mp4.stat().st_size // 1024} KiB), "
        f"{gif} ({gif.stat().st_size // 1024} KiB)"
    )
    return status


def main(
    *,
    scenario: Annotated[
        str | None,
        typer.Option(
            help="Record only this scenario (yaml or markdown); default both."
        ),
    ] = None,
    width: Annotated[int, typer.Option(help="Capture width in pixels.")] = 1280,
    height: Annotated[int, typer.Option(help="Capture height in pixels.")] = 800,
    fps: Annotated[int, typer.Option(help="Capture frame rate.")] = 15,
    display_num: Annotated[
        str, typer.Option(help="Xvfb display number (Linux).")
    ] = "99",
    window_title: Annotated[
        str, typer.Option(help="VS Code window title to capture (Windows gdigrab).")
    ] = "ryl demo",
    avf_input: Annotated[
        str, typer.Option(help="avfoundation input device (macOS).")
    ] = "Capture screen 0",
    ffmpeg: Annotated[
        str | None, typer.Option(help="ffmpeg binary path (default: auto-detect).")
    ] = None,
    ffprobe: Annotated[
        str | None, typer.Option(help="ffprobe binary path (default: auto-detect).")
    ] = None,
) -> None:
    """Record the demo clip(s) for the requested scenario(s)."""
    device = CAPTURE_DEVICE.get(sys.platform)
    if device is None:
        raise fail(f"unsupported platform: {sys.platform}")
    scenarios = SCENARIOS if scenario is None else (scenario,)
    if any(name not in SCENARIOS for name in scenarios):
        raise fail(f"unknown scenario; choose from {', '.join(SCENARIOS)}")

    settings = Settings(
        device=device,
        ffmpeg=resolve_ffmpeg(device, ffmpeg),
        ffprobe=resolve_ffprobe(ffprobe),
        npx=require("npx"),
        width=width,
        height=height,
        fps=fps,
        display_num=display_num,
        window_title=window_title,
        avf_input=avf_input,
        ready=Path(tempfile.gettempdir()) / "ryl-demo-ready",
    )
    npm = require("npm")
    OUT_DIR.mkdir(exist_ok=True)

    procs: list[subprocess.Popen] = []
    try:
        log("compiling extension + montage")
        # Build the test sources (out/, the montage) and the extension bundle
        # (dist/, what VS Code loads) so a client change is live in the recording.
        subprocess.run([npm, "run", "compile-tests"], check=True)
        subprocess.run([npm, "run", "compile"], check=True)

        # env carries the recorder->montage IPC (the montage is a Node process):
        # the ready-signal path and, per run, the scenario.
        env = dict(os.environ)
        env["RYL_DEMO_READY"] = str(settings.ready)
        if device == "x11grab":
            log(f"starting Xvfb :{settings.display_num} ({width}x{height})")
            xvfb = subprocess.Popen(
                [
                    "Xvfb",
                    f":{settings.display_num}",
                    "-screen",
                    "0",
                    f"{width}x{height}x24",
                    "-nolisten",
                    "tcp",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            procs.append(xvfb)
            env["DISPLAY"] = f":{settings.display_num}"
            time.sleep(2)

        statuses = [record_one(settings, name, env, procs) for name in scenarios]
        if any(statuses):
            raise typer.Exit(code=1)
    finally:
        for proc in reversed(procs):
            terminate(proc)
        settings.ready.unlink(missing_ok=True)


if __name__ == "__main__":
    typer.run(main)
