#!/bin/sh
# ForceKitBuilder — MockbaMod addon manage.sh
#
# Standard ENABLE/DISABLE/UNINSTALL contract (see
# mockbamod-module-creator skill's references/architecture.md). This is a
# plain background process, not a continuous audio/MIDI engine and not an
# LD_PRELOAD/acvs-restart addon — see DESIGN.md's v2 scoping section for
# why (Kit Builder is request/response, not a live engine).
appname=forcekitbuilder
appTitle="Force Kit Builder"
appDir=ForceKitBuilder

mmPath=$(cat /dev/shm/.mmPath)
. "$mmPath/MockbaMod/env.sh"

runDir="$mmPath/AddOns/"
installroot="$mmPath/AddOns/$appDir/"
runScript="$runDir/run_$appname.sh"
mode=$1

if [ "$mode" = "ENABLE" ]; then
    cp -f "$installroot/run_$appname.sh" "$runScript"
    "$runScript"
fi

if [ "$mode" = "DISABLE" ]; then
    "$runScript" kill 2>/dev/null
    rm -f "$runScript"
fi

if [ "$mode" = "UNINSTALL" ]; then
    "$runScript" kill 2>/dev/null
    rm -f "$runScript"
fi
