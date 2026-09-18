#!/usr/bin/env bash
#
# Force Kit Builder — install into an existing nodeServer install.
#
# This is not a standalone MockbaMod addon (see DESIGN.md for why): it's a
# plugin patched into an already-installed nodeServer, the same way the
# force-acid/force-dx7/force-jv880 family's nodeserver-integration/ folders
# patch a redirect stub into nodeServer today — this just installs a full
# feature instead of a one-line redirect.
#
# Usage: ./install.sh [path-to-nodeServer-app-dir]
#   e.g. ./install.sh /media/662522/AddOns/nodeServer/app
#
# If no path is given, tries to auto-detect via /dev/shm/.mmPath (the same
# convention MockbaMod addons use to locate the install root) — but this is
# a convenience, not a guarantee; pass the path explicitly if it's wrong.

set -euo pipefail

usage() {
    echo "Usage: $0 <path-to-nodeServer-app-dir>" >&2
    echo "  e.g. $0 /media/662522/AddOns/nodeServer/app" >&2
    exit 1
}

TARGET="${1:-}"
if [ -z "$TARGET" ] && [ -f /dev/shm/.mmPath ]; then
    MM_PATH="$(cat /dev/shm/.mmPath)"
    CANDIDATE="$MM_PATH/AddOns/nodeServer/app"
    if [ -d "$CANDIDATE" ]; then
        TARGET="$CANDIDATE"
        echo "Auto-detected nodeServer at: $TARGET"
    fi
fi
[ -z "$TARGET" ] && usage
[ -d "$TARGET/api/endpoints" ] || { echo "error: '$TARGET' doesn't look like a nodeServer app/ directory (no api/endpoints subfolder)" >&2; exit 1; }

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing Force Kit Builder into: $TARGET"

# core/ + exporters/ live in their own subtree alongside api/endpoints/, kept
# separate from nodeServer's own client/apps/ or api/endpoints/ conventions
# since these are plain ES modules (see kitbuilder/index.js's doc for how the
# CommonJS endpoint bridges to them). data/ (the working kit, sample index,
# preferences, config) is deliberately NOT touched by an upgrade.
rm -rf "$TARGET/kitbuilder-core/core" "$TARGET/kitbuilder-core/exporters"
mkdir -p "$TARGET/kitbuilder-core"
cp -r "$SRC_DIR/core" "$TARGET/kitbuilder-core/core"
cp -r "$SRC_DIR/exporters" "$TARGET/kitbuilder-core/exporters"

rm -rf "$TARGET/api/endpoints/kitbuilder"
cp -r "$SRC_DIR/plugin/api/endpoints/kitbuilder" "$TARGET/api/endpoints/kitbuilder"

ENDPOINTS_FILE="$TARGET/api/ENDPOINTS.js"
if [ -f "$ENDPOINTS_FILE" ] && grep -qE "['\"]\/kit-builder['\"]" "$ENDPOINTS_FILE"; then
    echo "ENDPOINTS.js already has a /kit-builder entry — leaving it alone."
else
    cat <<'EOF'

MANUAL STEP required — add this entry to nodeServer's app/api/ENDPOINTS.js
(inside the module.exports array, alongside its other entries):

    {
        NAME: "Kit Builder",
        PATH: "./api/endpoints/kitbuilder/index.js",
        PARAM: "/kit-builder",
        URL: "/kit-builder",
        HIDDEN: false,
        HOME: true,
        TARGET: "_self"
    },

(the same snippet is in plugin/ENDPOINTS.patch.md)
EOF
fi

cat <<EOF

Done. Restart nodeServer for the new route to load (kill its node process —
its own watchdog relaunches it), then open:

    http://<force-ip>:8080/kit-builder

EOF
