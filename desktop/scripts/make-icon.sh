#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
master="$root/resources/icon-master.jpg"
svg="$root/resources/icon.svg"
png="$root/resources/icon.png"
icns="$root/resources/icon.icns"
setdir="$root/resources/TinyWhale.iconset"

if [[ -f "$master" ]]; then
  python3 "$root/scripts/compose-icon.py" "$master" "$png"
else
  rsvg-convert -w 1024 -h 1024 "$svg" > "$png"
fi

rm -rf "$setdir"
mkdir "$setdir"
sips -z 16 16 "$png" --out "$setdir/icon_16x16.png" >/dev/null
sips -z 32 32 "$png" --out "$setdir/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$png" --out "$setdir/icon_32x32.png" >/dev/null
sips -z 64 64 "$png" --out "$setdir/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$png" --out "$setdir/icon_128x128.png" >/dev/null
sips -z 256 256 "$png" --out "$setdir/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$png" --out "$setdir/icon_256x256.png" >/dev/null
sips -z 512 512 "$png" --out "$setdir/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$png" --out "$setdir/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$png" --out "$setdir/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$setdir" -o "$icns"
rm -rf "$setdir"

ICON_PNG="$png" python3 - <<'PY'
import os
from pathlib import Path
from PIL import Image
png = Path(os.environ['ICON_PNG'])
im = Image.open(png)
field = im.getpixel((8, 8))
mark = im.getpixel((im.size[0] // 2, im.size[1] // 2))
if not (field[2] > 150 and 40 < field[0] < 130 and field[2] > field[1]):
    raise SystemExit(f'icon field left the DeepSeek-blue family: {field}')
if mark[0] < 180 or mark[2] >= mark[0]:
    raise SystemExit(f'icon mark is not ivory: {mark}')
cut = Image.open(png.with_name('icon-mark.png'))
if cut.mode != 'RGBA' or cut.size != (512, 512):
    raise SystemExit(f'icon-mark.png must be 512 RGBA, got {cut.mode} {cut.size}')
extrema = cut.getextrema()
if extrema[3][1] < 200:
    raise SystemExit('icon-mark.png has no opaque mark')
PY

cp "$root/resources/icon-mark.png" "$root/../apps/web/public/icon-mark.png"
echo "wrote $png"
echo "wrote $icns"
echo "wrote $root/../apps/web/public/icon-mark.png"
