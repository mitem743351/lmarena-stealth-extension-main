#!/usr/bin/env bash
# Build a loadable zip of the extension.
#   ./pack.sh            -> dist/lmarena-stealth-<version>.zip
set -euo pipefail

cd "$(dirname "$0")"

version="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
out="dist/lmarena-stealth-${version}.zip"

mkdir -p dist
rm -f "$out"

# everything Chrome needs, nothing else (no tests, no node_modules, no docs)
zip -q -r "$out" \
  manifest.json boot.js main.js model-utils.js models-scan.js content.js styles.css \
  background.js popup.html popup.js icons \
  -x '*.DS_Store'

echo "built $out"
unzip -l "$out"
