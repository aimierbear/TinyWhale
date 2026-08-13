#!/bin/bash
# Install the unsigned local TinyWhale.app next to other Dev apps.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/release/mac-arm64/TinyWhale.app"
dest="$HOME/Applications/TinyWhale.app"

if [[ ! -d "$src" ]]; then
  echo "missing $src — run npm run pack first" >&2
  exit 1
fi

mkdir -p "$HOME/Applications"
rm -rf "$dest"
cp -R "$src" "$dest"
node "$root/scripts/write-checkout-root.mjs" "$dest/Contents/Resources/tinywhale-checkout.json"
codesign --force --deep --sign - "$dest" >/dev/null
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$dest"
echo "installed $dest"
