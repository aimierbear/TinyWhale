#!/usr/bin/env python3
"""Prepare a 1024 macOS icon master.

Default: preserve color and lighting, only flatten leftover white frame pixels.
Pass --silhouette to reduce the mark to ivory-on-teal (legacy).
Do not pre-round corners; Dock applies the system squircle to the .icns.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

SIZE = 1024
NAVY = (14, 42, 64)
IVORY = (242, 232, 213)


def is_ivory(pixel: tuple[int, ...]) -> bool:
    red, green, blue = pixel[:3]
    return red > 180 and green > 165 and blue > 130 and red >= blue and (red + green + blue) > 520


def flatten_white_frame(image: Image.Image, fill: tuple[int, int, int]) -> Image.Image:
    pixels = image.load()
    corner = image.getpixel((0, 0))[:3]
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue = pixels[x, y][:3]
            if red > 245 and green > 245 and blue > 245:
                pixels[x, y] = fill if sum(corner) < 500 else (red, green, blue)
    return image


def silhouette(image: Image.Image) -> Image.Image:
    result = Image.new("RGB", image.size, NAVY)
    source = image.load()
    dest = result.load()
    for y in range(image.height):
        for x in range(image.width):
            if is_ivory(source[x, y]):
                dest[x, y] = IVORY
    return result


def compose(src: Path, dest: Path, *, preserve: bool) -> None:
    source = Image.open(src).convert("RGB").resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    if preserve:
        flatten_white_frame(source, source.getpixel((8, 8))[:3])
        source.save(dest, "PNG")
        return
    source = silhouette(source)
    source.save(dest, "PNG")


if __name__ == "__main__":
    args = [item for item in sys.argv[1:] if item != "--silhouette"]
    preserve = "--silhouette" not in sys.argv[1:]
    if len(args) != 2:
        raise SystemExit("usage: compose-icon.py [--silhouette] <master> <png>")
    compose(Path(args[0]), Path(args[1]), preserve=preserve)
