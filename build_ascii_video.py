#!/usr/bin/env python3
"""Precompute the starship clip as colored ASCII and encode it back into an MP4.

Matches the in-browser renderer (same grid, buckets, luminance curve, saturation,
brightness scale and per-cell char hash) so the precomputed video looks identical.
"""
import os
import sys
import subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FFMPEG = "/tmp/ffbin/ffmpeg"
SRC = os.path.join(os.path.dirname(__file__), "assets", "starship_clip.mp4")
DST = os.path.join(os.path.dirname(__file__), "assets", "starship_ascii.mp4")

COLS = 200
ROWS = 60
FPS = 24

BUCKETS = [
    " ",
    " .`'",
    ".,-:",
    ";:!~",
    "i|1l",
    "Il?/",
    "<>()",
    "{}[]",
    "+=trf",
    "jxvoryc",
    "YZJLCn",
    "UXKO",
    "QU0O",
]
BLEN = len(BUCKETS)

FONT_CANDIDATES = [
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/SFNSMono.ttf",
    "/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Supplemental/Courier New.ttf",
]


def load_font(size: int):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def hash2(x: int, y: int, t: int) -> int:
    h = (x * 374761393) ^ (y * 668265263) ^ t
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return (h ^ (h >> 16)) & 0xFFFFFFFF


def build_glyph_masks(font, cell_w: int, cell_h: int):
    """Precompute antialiased alpha masks for every character we use."""
    charset = {c for bucket in BUCKETS for c in bucket if c != " "}
    masks = {}
    ascent, _ = font.getmetrics()
    for ch in charset:
        img = Image.new("L", (cell_w, cell_h), 0)
        d = ImageDraw.Draw(img)
        bbox = font.getbbox(ch)
        cw = bbox[2] - bbox[0]
        x = (cell_w - cw) // 2 - bbox[0]
        y = 0
        d.text((x, y), ch, fill=255, font=font)
        masks[ch] = np.asarray(img, dtype=np.float32) / 255.0
    return masks


def compute_frame_grid(pixels: np.ndarray, slow_t: int):
    """Given pixels (ROWS, COLS, 3) uint8, return (char_grid, color_grid)."""
    rgb = pixels.astype(np.float32)
    r = rgb[..., 0]
    g = rgb[..., 1]
    b = rgb[..., 2]

    lum = (r * 299 + g * 587 + b * 114) / 255000.0
    lum_curve = np.where(lum > 0, (np.power(np.clip(lum, 1e-6, 1), 0.85) - 0.04) * 1.1, 0.0)
    lum_curve = np.clip(lum_curve, 0.0, 1.0)

    b_idx = np.clip((lum_curve * (BLEN - 1) + 0.0001).astype(np.int32), 0, BLEN - 1)

    # Per-cell character selection via hash.
    char_grid = np.empty((ROWS, COLS), dtype="<U1")
    for y in range(ROWS):
        for x in range(COLS):
            pool = BUCKETS[b_idx[y, x]]
            h = hash2(x, y, slow_t)
            char_grid[y, x] = pool[h % len(pool)]

    # Saturation boost around the HSL midpoint.
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    mid = (mx + mn) * 0.5
    sat = 2.0
    sr = mid + (r - mid) * sat
    sg = mid + (g - mid) * sat
    sb = mid + (b - mid) * sat
    sr = np.clip(sr, 0, 255)
    sg = np.clip(sg, 0, 255)
    sb = np.clip(sb, 0, 255)

    bright_scale = 0.35 + lum_curve * 0.95
    sr = np.clip(sr * bright_scale, 0, 255)
    sg = np.clip(sg * bright_scale, 0, 255)
    sb = np.clip(sb * bright_scale, 0, 255)

    color_grid = np.stack([sr, sg, sb], axis=-1).astype(np.float32)
    return char_grid, color_grid


BG_FRACTION = 0.38


def render_frame(char_grid, color_grid, masks, cell_w, cell_h):
    out = np.zeros((ROWS * cell_h, COLS * cell_w, 3), dtype=np.float32)
    for y in range(ROWS):
        ty = y * cell_h
        for x in range(COLS):
            color = color_grid[y, x]
            tx = x * cell_w
            bg = color * BG_FRACTION
            fg = color
            ch = char_grid[y, x]
            if ch == " ":
                tile = np.broadcast_to(bg, (cell_h, cell_w, 3))
                out[ty:ty + cell_h, tx:tx + cell_w] = tile
            else:
                mask = masks[ch][..., None]
                out[ty:ty + cell_h, tx:tx + cell_w] = bg + mask * (fg - bg)
    np.clip(out, 0, 255, out=out)
    return out.astype(np.uint8)


def main():
    if not os.path.exists(FFMPEG):
        print(f"ffmpeg not found at {FFMPEG}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(SRC):
        print(f"source clip not found at {SRC}", file=sys.stderr)
        sys.exit(1)

    font_size = 10
    font = load_font(font_size)
    bbox = font.getbbox("M")
    cell_w = max(7, bbox[2] - bbox[0])
    ascent, descent = font.getmetrics()
    cell_h = ascent + descent
    print(f"font cell {cell_w}x{cell_h}")

    masks = build_glyph_masks(font, cell_w, cell_h)
    print(f"glyph masks: {len(masks)}")

    out_w = COLS * cell_w
    out_h = ROWS * cell_h
    print(f"output {out_w}x{out_h} @ {FPS}fps")

    decode_cmd = [
        FFMPEG, "-v", "error", "-i", SRC,
        "-vf", f"scale={COLS}:{ROWS},fps={FPS}",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    encode_cmd = [
        FFMPEG, "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{out_w}x{out_h}", "-r", str(FPS), "-i", "-",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-crf", "26", "-preset", "slow",
        "-profile:v", "high", "-level", "4.2",
        "-movflags", "+faststart", DST,
    ]

    dec = subprocess.Popen(decode_cmd, stdout=subprocess.PIPE)
    enc = subprocess.Popen(encode_cmd, stdin=subprocess.PIPE)

    frame_bytes = COLS * ROWS * 3
    frame_idx = 0
    try:
        while True:
            raw = dec.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            pixels = np.frombuffer(raw, dtype=np.uint8).reshape((ROWS, COLS, 3))
            t_ms = frame_idx * 1000.0 / FPS
            slow_t = int(t_ms / 110.0)
            char_grid, color_grid = compute_frame_grid(pixels, slow_t)
            img = render_frame(char_grid, color_grid, masks, cell_w, cell_h)
            enc.stdin.write(img.tobytes())
            frame_idx += 1
            if frame_idx % 30 == 0:
                print(f"  frame {frame_idx}", flush=True)
    finally:
        enc.stdin.close()
        dec.wait()
        enc.wait()
    print(f"done: {frame_idx} frames -> {DST}")


if __name__ == "__main__":
    main()
