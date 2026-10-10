#!/bin/bash
# Builds NetSketch in release mode and wraps the binary into build/NetSketch.app.
#
# Usage: scripts/make-app.sh
# Optional environment:
#   NETSKETCH_BUNDLE_ID   bundle identifier (default: org.netsketch.NetSketch, a placeholder)
#   NETSKETCH_VERSION     CFBundleShortVersionString (default: 0.1.0)
#   NETSKETCH_BUILD       CFBundleVersion (default: 1)
#
# Works with the Command Line Tools alone; Xcode is not needed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="NetSketch"
BUNDLE_ID="${NETSKETCH_BUNDLE_ID:-org.netsketch.NetSketch}"
VERSION="${NETSKETCH_VERSION:-0.1.0}"
BUILD_NUMBER="${NETSKETCH_BUILD:-1}"
DOC_UTI="${BUNDLE_ID}.project"
OUT_DIR="$ROOT/build"
APP="$OUT_DIR/$APP_NAME.app"

echo "==> swift build -c release"
swift build -c release --product "$APP_NAME"
BIN_DIR="$(swift build -c release --show-bin-path)"
BINARY="$BIN_DIR/$APP_NAME"
[ -x "$BINARY" ] || { echo "error: $BINARY was not built" >&2; exit 1; }

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/cs.lproj"
cp "$BINARY" "$APP/Contents/MacOS/$APP_NAME"

# SwiftPM resource bundles (devices.json lives in NetSketch_NetSketchCore.bundle).
#
# The accessor SwiftPM generates for Bundle.module looks for the bundle in
# Bundle.main.bundleURL, which for an app is the .app directory itself. Nothing may be put
# there: codesign refuses "unsealed contents present in the bundle root". The core therefore
# looks in Contents/Resources first (DeviceCatalog.bundledDevicesURL), and that is where the
# bundles go. The lookup is checked at the end of this script.
shopt -s nullglob
BUNDLES=("$BIN_DIR"/*.bundle)
shopt -u nullglob
if [ "${#BUNDLES[@]}" -eq 0 ]; then
    echo "error: no SwiftPM resource bundle (*.bundle) found in $BIN_DIR" >&2
    exit 1
fi
for bundle in "${BUNDLES[@]}"; do
    echo "    resource bundle: $(basename "$bundle")"
    cp -R "$bundle" "$APP/Contents/Resources/"
done

# Declares Czech as the app's language so that the system-provided menu items and panels
# match the Czech interface.
cat > "$APP/Contents/Resources/cs.lproj/InfoPlist.strings" <<EOF
"CFBundleName" = "$APP_NAME";
"CFBundleDisplayName" = "$APP_NAME";
EOF

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>cs</string>
    <key>CFBundleLocalizations</key>
    <array>
        <string>cs</string>
    </array>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>$APP_NAME</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
    <key>CFBundleVersion</key>
    <string>$BUILD_NUMBER</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.education</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key>
            <string>Projekt NetSketch</string>
            <key>CFBundleTypeRole</key>
            <string>Editor</string>
            <key>LSHandlerRank</key>
            <string>Owner</string>
            <key>LSItemContentTypes</key>
            <array>
                <string>$DOC_UTI</string>
            </array>
        </dict>
    </array>
    <key>UTExportedTypeDeclarations</key>
    <array>
        <dict>
            <key>UTTypeIdentifier</key>
            <string>$DOC_UTI</string>
            <key>UTTypeDescription</key>
            <string>Projekt NetSketch</string>
            <key>UTTypeConformsTo</key>
            <array>
                <string>public.json</string>
            </array>
            <key>UTTypeTagSpecification</key>
            <dict>
                <key>public.filename-extension</key>
                <array>
                    <string>netsketch</string>
                </array>
            </dict>
        </dict>
    </array>
</dict>
</plist>
EOF
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "==> ad-hoc code signing"
codesign --force --deep -s - "$APP"
codesign --verify --deep --strict "$APP"

echo "==> checking that the packaged app finds its catalog"
INFO="$("$APP/Contents/MacOS/$APP_NAME" --catalog-info)" || {
    echo "$INFO"
    echo "error: the packaged app could not load devices.json" >&2
    exit 1
}
echo "$INFO" | sed 's/^/    /'
case "$INFO" in
    *"$APP_NAME.app/Contents/Resources/"*"devices.json"*) ;;
    *)
        echo "error: devices.json was found outside the app bundle (see above); the app would not work on another machine" >&2
        exit 1
        ;;
esac

echo "==> done: $APP"
echo "    open \"$APP\"        # or double-click it in Finder"
