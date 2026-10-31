#!/bin/sh
# Rebuild the Wi-Fi helper only when its source is newer than the binary.
# `tauri dev` watches src-tauri; rewriting the binary on every start
# recompiles Rust and closes the window before opening it again.
cd "$(dirname "$0")/.." || exit 0
src="src-tauri/resources/wifi-helper.swift"
out="src-tauri/resources/wifi-helper"
if [ -x "$out" ] && [ "$out" -nt "$src" ]; then
  exit 0
fi
swiftc -O -o "$out" "$src" || echo '[warn] wifi-helper build failed; Wi-Fi details will be limited'
