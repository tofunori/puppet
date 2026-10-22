#!/usr/bin/env bash
# Builds "Puppet.app" from PuppetMenu.swift into the folder given (default ~/Applications)
# and prints the app's path. Needs the Xcode command line tools (swiftc).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HOME/Applications}"
APP="$OUT/Puppet.app"
# The app was called "codex-cu Menu" before; the old copy is removed so Spotlight finds one.
rm -rf "$OUT/codex-cu Menu.app"

mkdir -p "$APP/Contents/MacOS"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
swiftc -O -parse-as-library -o "$APP/Contents/MacOS/puppet-menu" "$DIR/PuppetMenu.swift"
# A stable identity keeps the Screen Recording permission across rebuilds; an ad hoc signature
# changes with every build, and macOS then asks again. PUPPET_SIGN_IDENTITY picks one; otherwise
# the first "Apple Development" identity in the keychain, else ad hoc.
IDENTITY="${PUPPET_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)}"
codesign --force --sign "${IDENTITY:--}" "$APP" >/dev/null 2>&1 || codesign --force --sign - "$APP" >/dev/null 2>&1
echo "$APP"
