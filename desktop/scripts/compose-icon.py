#!/usr/bin/env python3
"""Fit the whale artwork to a full-bleed 1024 macOS icon canvas.

The source must be a square with a flat background. This script does not
round corners: Finder and Dock apply the system squircle to the .icns.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

SIZE = 1024
# Apple's grid leaves a little air, but the background must go edge to edge.
FILL = 0.88
TEAL = (21, 81, 92)
IVORY = (242, 232, 213)


def is_ivory(pixel: tuple[int, ...]) -> bool:
    red, green, blue = pixel[:3]
    return red > 180 and green > 165 and blue > 130 and red >= blue and (red + green + blue) > 520


def subject_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    pixels = image.load()
    width, height = image.size
    left, top, right, bottom = width, height, 0, 0
    found = False
    for y in range(height):
        for x in range(width):
            if not is_ivory(pixels[x, y]):
                continue
            found = True
            left = min(left, x)
            top = min(top, y)
            right = max(right, x)
            bottom = max(bottom, y)
    if not found:
        raise SystemExit("compose-icon: no ivory subject pixels found")
    return left, top, right + 1, bottom + 1


def silhouette(image: Image.Image) -> Image.Image:
    result = Image.new("RGB", image.size, TEAL)
    source = image.load()
    dest = result.load()
    for y in range(image.height):
        for x in range(image.width):
            if is_ivory(source[x, y]):
                dest[x, y] = IVORY
    return result


def compose(src: Path, dest: Path) -> None:
    source = silhouette(Image.open(src).convert("RGB"))
    box = subject_bbox(source)
    subject = source.crop(box)
    target = max(1, int(SIZE * FILL))
    scale = min(target / subject.width, target / subject.height)
    fitted = subject.resize(
        (max(1, int(subject.width * scale)), max(1, int(subject.height * scale))),
        Image.Resampling.LANCZOS,
    )
    fitted = silhouette(fitted)
    canvas = Image.new("RGB", (SIZE, SIZE), TEAL)
    canvas.paste(fitted, ((SIZE - fitted.width) // 2, (SIZE - fitted.height) // 2))
    canvas.save(dest, "PNG")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: compose-icon.py <master> <png>")
    compose(Path(sys.argv[1]), Path(sys.argv[2]))
