#!/bin/zsh
# Builds the USB recording helper usb-screen and the app wrapper "iPhone Capture.app".
#   zsh build.sh          build (binary + app wrapper, ad-hoc signed)
#   zsh build.sh --check  only check whether both are up to date (exit 0 = up to date, 1 = rebuild needed)
# The app wrapper is only needed for Claude Code/Codex: macOS gives their shells no camera permission, while an app
# with NSCameraUsageDescription can get it after a one-time consent.
# Note: after rebuilding the app, macOS may ask for the permission again (the ad-hoc signature changes).
#
# Identifiers (optional, e.g. in <kit>/.env.local, see env.example). Keep them stable once macOS granted access:
#   IPHONE_HELPER_ID          code-signing identifier of helper/usb-screen
#   IPHONE_CAPTURE_BUNDLE_ID  bundle identifier of the app wrapper
set -euo pipefail
here=${0:A:h}
src=$here/helper/usb-screen.swift
bin=$here/helper/usb-screen
app="$here/helper/iPhone Capture.app"
appbin="$app/Contents/MacOS/usb-screen"

if [[ ${1:-} == --check ]]; then
  [[ -x $bin && $bin -nt $src && -x $appbin && $appbin -nt $src ]] && { echo "up to date"; exit 0; }
  echo "rebuild needed: zsh $0"; exit 1
fi

if [[ -f $here/../.env.local ]]; then source "$here/../.env.local"; fi
helper_id=${IPHONE_HELPER_ID:-io.github.gabba6.agent-iphone-kit.usb-screen}
bundle_id=${IPHONE_CAPTURE_BUNDLE_ID:-io.github.gabba6.agent-iphone-kit.capture}

command -v swiftc >/dev/null || { echo "swiftc missing (Xcode Command Line Tools)"; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
swiftc -O -swift-version 5 "$src" -o "$tmp/usb-screen"
install -m 0755 "$tmp/usb-screen" "$bin"
codesign --force --sign - --identifier "$helper_id" "$bin" >/dev/null 2>&1

mkdir -p "$app/Contents/MacOS"
install -m 0755 "$tmp/usb-screen" "$appbin"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${bundle_id}</string>
  <key>CFBundleName</key><string>iPhone Capture</string>
  <key>CFBundleDisplayName</key><string>iPhone Capture</string>
  <key>CFBundleExecutable</key><string>usb-screen</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSCameraUsageDescription</key><string>Records only the screen of the iPhone connected via USB (no Mac camera, no audio).</string>
</dict>
</plist>
PLIST
codesign --force --sign - --identifier "$bundle_id" "$app" >/dev/null 2>&1
echo "built: $bin"
echo "built: $app"
