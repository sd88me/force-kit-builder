#!/bin/sh
# ForceKitBuilder — top-level boot-loop launcher (copied into AddOns/ by
# manage.sh ENABLE). Must accept a `kill` argument — the boot loop calls
# `"$f" kill` on every boot before relaunching (see mockbamod-module-creator
# skill's references/architecture.md).
mmPath=$(cat /dev/shm/.mmPath)
. "$mmPath/MockbaMod/env.sh"

daemon="$mmPath/AddOns/ForceKitBuilder/host/daemon.mjs"
node="$mmPath/AddOns/nodeServer/node/bin/node"

# Kill by matching the daemon's own script path in the process list, not a
# generic `node` process name — killall/pkill on a bare "node" name would
# also take down nodeServer itself (see manage.sh's note on why this isn't
# killall). BusyBox `ps` has no `-o`/long-format args to grep more precisely
# than this, same constraint nodeServer's own restart script works around.
existing=$(ps | grep "daemon.mjs" | grep -v grep | grep -o -E '[0-9]+' | head -n1)

if [ "$1" = "kill" ]; then
    [ -n "$existing" ] && kill -9 $existing 2>/dev/null
else
    [ -n "$existing" ] && kill -9 $existing 2>/dev/null
    "$node" "$daemon" >/tmp/forcekitbuilder.log 2>&1 &
fi
