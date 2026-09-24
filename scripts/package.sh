#!/usr/bin/env bash
# Build the SD-card release zip: dist-zip/ForceKitBuilder-<version>.zip,
# unpacking to the same two folders scripts/deploy.sh puts on the device:
#   AddOns/ForceKitBuilder/        addon/ (daemon, shadow page, preview_host)
#   AddOns/force-kit-builder-src/  the nodeServer plugin + install.sh, which
#                                  still has to be run once on the device
# Unzip it onto the SD card root. Uses the committed addon/preview_host -
# rebuild (scripts/build_preview.sh) and commit it first if its source changed.
# .github/workflows/release.yml runs this for every published release.
set -euo pipefail
cd "${PKG_ROOT:-$(dirname "$0")/..}"
VER="${1:-$(git describe --tags --always)}"
OUT="$PWD/dist-zip"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
A="$STAGE/AddOns/ForceKitBuilder"
P="$STAGE/AddOns/force-kit-builder-src"
mkdir -p "$STAGE/AddOns" "$P" "$OUT"
cp -r addon "$A"
cp -r core exporters plugin install.sh "$P/"
find "$STAGE" \( -name __pycache__ -prune -o -name node_modules -prune -o -name '*.pyc' -o -name .gitkeep \) -exec rm -rf {} +
chmod 0755 "$A"/*.sh "$A/preview_host" "$P/install.sh"
rm -f "$OUT/ForceKitBuilder-$VER.zip"
python3 -c "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], 'AddOns')" "$OUT/ForceKitBuilder-$VER" "$STAGE"
python3 -m zipfile -l "$OUT/ForceKitBuilder-$VER.zip"
