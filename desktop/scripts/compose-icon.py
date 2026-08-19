#!/usr/bin/env python3
"""Prepare a 1024 macOS icon master.

Keep the ivory mark. Paint a DeepSeek-hue field that reads as official
blue without the neon wall of raw #4D6BFE. Highlight stays tinted.
Do not pre-round corners; Dock applies the system squircle to the .icns.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageFilter

SIZE = 1024
# Official hue (~230°) kept; chroma and peak luminance pulled down so a
# 1024 field and a full-window splash do not read as a light source.
# #4D6BFE remains the brand sample, not the wallpaper.
FIELD = (67, 92, 219)
HIGHLIGHT = (154, 170, 236)
SHADOW = (48, 66, 168)
IVORY = (242, 232, 213)


def ivory_score(pixel: tuple[int, ...]) -> float:
    red, green, blue = pixel[:3]
    # Cream is warm. Field and highlight are cold (B > R) and stay in the field.
    if blue > red + 6:
        return 0.0
    if red > 180 and green > 165 and blue > 130 and red >= blue and (red + green + blue) > 520:
        return 1.0
    average = (red + green + blue) / 3.0
    if average > 145 and red >= blue and red > 130:
        return max(0.0, min(1.0, (average - 145) / 75))
    return 0.0


def is_ivory(pixel: tuple[int, ...]) -> bool:
    return ivory_score(pixel) >= 1.0


def lerp(start: tuple[int, int, int], end: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    amount = 0.0 if amount < 0 else 1.0 if amount > 1 else amount
    return tuple(int(round(start[i] + (end[i] - start[i]) * amount)) for i in range(3))


def flatten_white_frame(image: Image.Image, fill: tuple[int, int, int]) -> Image.Image:
    pixels = image.load()
    corner = image.getpixel((0, 0))[:3]
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue = pixels[x, y][:3]
            if red > 245 and green > 245 and blue > 245:
                pixels[x, y] = fill if sum(corner) < 500 else (red, green, blue)
    return image


def official_field(size: int) -> Image.Image:
    field = Image.new('RGB', (size, size), FIELD)
    pixels = field.load()
    cx, cy = size * 0.5, size * 0.10
    for y in range(size):
        for x in range(size):
            nx = (x - cx) / (size * 0.72)
            ny = (y - cy) / (size * 0.95)
            distance = math.sqrt(nx * nx + ny * ny * 0.78)
            if distance < 0.55:
                # Tinted wash, never a white core.
                color = lerp(HIGHLIGHT, FIELD, (distance / 0.55) ** 1.15)
            else:
                color = lerp(FIELD, SHADOW, min(1.0, (distance - 0.55) / 0.70))
            drop = max(0.0, (y / size - 0.50) / 0.50)
            if drop > 0:
                color = lerp(color, SHADOW, drop * 0.42)
            pixels[x, y] = color
    return field


def extract_mark(image: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Ivory silhouette and its soft alpha, same size as the source."""
    mask = Image.new('L', image.size, 0)
    mark = Image.new('RGB', image.size, IVORY)
    source = image.load()
    mask_pixels = mask.load()
    mark_pixels = mark.load()
    for y in range(image.height):
        for x in range(image.width):
            pixel = source[x, y]
            score = ivory_score(pixel)
            mask_pixels[x, y] = int(round(score * 255))
            if score > 0:
                mark_pixels[x, y] = pixel[:3]
    mask = mask.filter(ImageFilter.GaussianBlur(radius=0.6))
    return mark, mask


def write_mark_png(mark: Image.Image, mask: Image.Image, dest: Path) -> None:
    """Crop the tail onto a transparent square for the splash."""
    box = mask.getbbox()
    if box is None:
        raise SystemExit('icon mark is empty')
    pad = 48
    left = max(0, box[0] - pad)
    top = max(0, box[1] - pad)
    right = min(mark.width, box[2] + pad)
    bottom = min(mark.height, box[3] + pad)
    cut = Image.new('RGBA', (right - left, bottom - top), (0, 0, 0, 0))
    cut.paste(mark.crop((left, top, right, bottom)), (0, 0), mask.crop((left, top, right, bottom)))
    side = max(cut.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(cut, ((side - cut.width) // 2, (side - cut.height) // 2), cut)
    square.resize((512, 512), Image.Resampling.LANCZOS).save(dest, 'PNG')


def recolor_field(image: Image.Image) -> tuple[Image.Image, Image.Image, Image.Image]:
    """Keep the ivory mark; replace the field with the softened DeepSeek wash."""
    mark, mask = extract_mark(image)
    result = official_field(image.width)
    result.paste(mark, (0, 0), mask)
    return result, mark, mask


def silhouette(image: Image.Image) -> Image.Image:
    result = Image.new('RGB', image.size, FIELD)
    source = image.load()
    dest = result.load()
    for y in range(image.height):
        for x in range(image.width):
            if is_ivory(source[x, y]):
                dest[x, y] = IVORY
    return result


def compose(src: Path, dest: Path, *, preserve: bool) -> None:
    source = Image.open(src).convert('RGB').resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    if preserve:
        flatten_white_frame(source, source.getpixel((8, 8))[:3])
        painted, mark, mask = recolor_field(source)
        painted.save(dest, 'PNG')
        write_mark_png(mark, mask, dest.with_name('icon-mark.png'))
        return
    source = silhouette(source)
    source.save(dest, 'PNG')


if __name__ == '__main__':
    args = [item for item in sys.argv[1:] if item != '--silhouette']
    preserve = '--silhouette' not in sys.argv[1:]
    if len(args) != 2:
        raise SystemExit('usage: compose-icon.py [--silhouette] <master> <png>')
    compose(Path(args[0]), Path(args[1]), preserve=preserve)
