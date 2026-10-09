#!/bin/sh
# Builds routine-tui with the short commit of the source as its version ("+" when the working copy has changes).
set -e
cd "$(dirname "$0")"
v=$(jj log -r @- --no-graph -T 'commit_id.short(8)' 2>/dev/null || echo dev)
[ -n "$(jj diff --summary 2>/dev/null)" ] && v="$v+"
go build -ldflags "-X main.version=$v" -o routine-tui .
