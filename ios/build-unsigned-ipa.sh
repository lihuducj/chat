#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_PATH="$SCRIPT_DIR/ServiceDesk.xcodeproj"
OUTPUT_DIR="$SCRIPT_DIR/output"
BUNDLE_ID="${BUNDLE_ID:-com.example.servicedesk}"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/servicedesk-build.XXXXXX")"

cleanup() {
  case "$TEMP_ROOT" in
    "${TMPDIR:-/tmp}"/servicedesk-build.*) rm -rf "$TEMP_ROOT" ;;
  esac
}
trap cleanup EXIT

echo "Building ServiceDesk (no APNs) with Bundle ID: $BUNDLE_ID"
xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme ServiceDesk \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$TEMP_ROOT/DerivedData" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY='' \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  build

APP_PATH="$TEMP_ROOT/DerivedData/Build/Products/Release-iphoneos/ServiceDesk.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "Build finished but ServiceDesk.app was not found." >&2
  exit 1
fi

mkdir -p "$TEMP_ROOT/Payload" "$OUTPUT_DIR"
cp -R "$APP_PATH" "$TEMP_ROOT/Payload/"
IPA_PATH="$OUTPUT_DIR/ServiceDesk-no-apns-unsigned.ipa"
rm -f "$IPA_PATH"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$TEMP_ROOT/Payload" "$IPA_PATH"

echo
echo "Unsigned IPA created:"
echo "$IPA_PATH"
echo "Import this file into Feather and sign it with your UDID certificate."
