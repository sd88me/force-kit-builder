#!/usr/bin/env bash
# Deploy Force Kit Builder onto a live MockbaMod Force in one command.
# Usage: scripts/deploy.sh user@force-ip
#
# Unlike a typical MockbaMod addon, this repo has THREE parts installed
# in different ways (see ../DESIGN.md's "Architecture" and "Shadow-GUI
# addon and preview_host" sections):
#
#   1. A nodeServer PLUGIN (core/, exporters/, plugin/) - patched into an
#      already-installed nodeServer addon's app/ directory by install.sh,
#      which must itself run ON THE DEVICE (it does local `cp -r` into
#      nodeServer's tree, no scp inside it). So this script stages the
#      plugin's source files to the device first, then runs install.sh
#      remotely over ssh against $mmPath/AddOns/nodeServer/app.
#   2. The standalone ForceKitBuilder ADDON (addon/) - a real MockbaMod
#      addon (daemon.mjs, manage.sh, NSMODULE.json for preview_host,
#      shadow_page.conf). Deployed with the standard rm-rf+scp pattern and
#      enabled unattended - manage.sh does no LD_PRELOAD/acvs work, so its
#      ENABLE is safe to run without a human present (confirmed by reading
#      manage.sh's own header comment).
#   3. preview_host - part of the ForceKitBuilder addon folder, but NEVER
#      auto-started by this script. Same hard rule as Maze Voice/DX7/
#      JV-880: a voice/preview producer must only ever be started manually
#      from the nodeServer Modules page, never scripted, never at boot -
#      see README.md's "Audible pad preview" section.
set -euo pipefail
cd "$(dirname "$0")/.."

ADDON_DIR="ForceKitBuilder"          # device-side AddOns/<ADDON_DIR> folder name
STAGING_DIR="force-kit-builder-src"  # device-side staging folder for part 1's source

HOST="${1:?usage: scripts/deploy.sh user@force-ip}"

for f in core exporters plugin install.sh; do
  [ -e "$f" ] || { echo "error: '$f' not found - run this from the repo root." >&2; exit 1; }
done
[ -d addon ] || { echo "error: addon/ not found." >&2; exit 1; }

mmPath="$(ssh "$HOST" 'cat /dev/shm/.mmPath')"
echo "== remote mmPath: $mmPath =="
NODESERVER_APP="$mmPath/AddOns/nodeServer/app"

# --- Part 1: nodeServer plugin -------------------------------------------
#
# install.sh only does local cp -r calls and must run on the device itself,
# so stage this repo's source files (not the whole repo - no need to ship
# addon/, tests/, scripts/, .git/, etc.) to a scratch folder next to
# nodeServer, then invoke install.sh remotely against nodeServer's app/ dir.
echo "== staging nodeServer plugin source to device =="
STAGING_PATH="$mmPath/AddOns/$STAGING_DIR"
ssh "$HOST" "rm -rf '$STAGING_PATH' && mkdir -p '$STAGING_PATH'"
scp -r core exporters plugin install.sh "$HOST:$STAGING_PATH/"

echo "== running install.sh on the device against nodeServer's app/ =="
# install.sh's own output (including any ENDPOINTS.js manual-step notice)
# is left to print straight to this terminal, unfiltered.
ssh "$HOST" "cd '$STAGING_PATH' && ./install.sh '$NODESERVER_APP'"

# --- Part 2: ForceKitBuilder addon (daemon.mjs + shadow GUI + preview_host,
#     but only daemon.mjs is auto-launched here) --------------------------
echo "== deploying ForceKitBuilder addon =="
ADDON_PATH="$mmPath/AddOns/$ADDON_DIR"
# scp -r into an existing destination NESTS rather than merges - remove first.
ssh "$HOST" "rm -rf '$ADDON_PATH'"
scp -r addon "$HOST:$ADDON_PATH"

ssh "$HOST" "chmod +x '$ADDON_PATH/manage.sh' '$ADDON_PATH/run_forcekitbuilder.sh' '$ADDON_PATH/preview_host' 2>/dev/null || true"
ssh "$HOST" "'$ADDON_PATH/manage.sh' ENABLE"

cat <<EOF

== Force Kit Builder deployed. ==

Still to do, in order:

1. Restart nodeServer for the new /kit-builder route to load (kill its
   node process - its own watchdog relaunches it), then open:
       http://${HOST#*@}:8080/kit-builder

2. Check the install.sh output above for an ENDPOINTS.js MANUAL STEP
   notice - if nodeServer's app/api/ENDPOINTS.js didn't already have a
   /kit-builder entry, you need to add the printed snippet by hand.

3. If you want audible pad preview: enable the separate ForceAudioJack
   addon (https://github.com/sd88me/force-audio-jack) once, if not
   already installed/enabled.

4. preview_host starts/stops itself automatically as you enter/leave the
   Kit Builder shadow page (engine_autostart=1) - no manual toggle needed.
   It is NEVER auto-launched at boot, by design (see README.md's "Audible
   pad preview" section). Do not restart acvs while it's attached to a
   live preview.

The ForceKitBuilder addon's daemon.mjs (shadow GUI backend) is already
running from boot - reach the touchscreen page via force-shadow's ADD-ONS
launcher (SHIFT+SCENE-7), not a direct SHIFT+SCENE-N combo.
EOF
