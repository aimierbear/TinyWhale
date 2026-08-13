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
echo "wrote $png"
echo "wrote $icns"
