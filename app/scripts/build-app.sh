#!/usr/bin/env bash
# Builds, signs and verifies Routine.app.
#   scripts/build-app.sh [--notarize] [--install]
# --notarize  submits to Apple with the AC_NOTARY keychain profile, then staples
# --install   replaces /Applications/Routine.app and relaunches it
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IDENTITY="${ROUTINE_SIGN_IDENTITY:-Developer ID Application: Alain Clément (BA768YL9DY)}"
NOTARY_PROFILE="${ROUTINE_NOTARY_PROFILE:-AC_NOTARY}"
NOTARIZE=0
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --notarize) NOTARIZE=1 ;;
    --install) INSTALL=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$APP_DIR"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/Routine"

OUT="$APP_DIR/.build/Routine.app"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp "$BIN" "$OUT/Contents/MacOS/Routine"
cp Resources/Info.plist "$OUT/Contents/Info.plist"

codesign --sign "$IDENTITY" --options runtime --entitlements Resources/Routine.entitlements --timestamp --force "$OUT"
codesign --verify --deep --strict --verbose=2 "$OUT"

if [ "$NOTARIZE" = 1 ]; then
  ZIP="$APP_DIR/.build/Routine.zip"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$OUT" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$OUT"
  xcrun stapler validate "$OUT"
fi

if [ "$INSTALL" = 1 ]; then
  pkill -x Routine 2>/dev/null || true
  rm -rf /Applications/Routine.app
  ditto "$OUT" /Applications/Routine.app
  open /Applications/Routine.app
  echo "installed /Applications/Routine.app"
else
  echo "built $OUT"
fi
