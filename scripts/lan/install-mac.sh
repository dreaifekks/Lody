#!/usr/bin/env bash
# Installs the Lody OSS LAN desktop build on macOS.
#
#   curl -fsSL https://github.com/__LODY_LAN_REPOSITORY__/releases/download/__LODY_LAN_TAG__/install-mac.sh | bash
#
# The build is not notarized. A file fetched by this script carries no
# quarantine mark, so the installed application opens without a Gatekeeper
# prompt; a copy downloaded with a browser does not.
set -euo pipefail

REPOSITORY="__LODY_LAN_REPOSITORY__"
TAG="__LODY_LAN_TAG__"
VERSION="__LODY_LAN_VERSION__"
BASE_URL="${LODY_LAN_BASE_URL:-https://github.com/${REPOSITORY}/releases/download/${TAG}}"
APPLICATION_NAME="Lody OSS.app"
INSTALL_DIR="${LODY_LAN_APPLICATIONS_DIR:-/Applications}"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS; use install.sh on a server"

case "$(uname -m)" in
  arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

asset="LodyOSS-lan-mac-${arch}.zip"
workdir="$(mktemp -d "${TMPDIR:-/tmp}/lody-lan-install.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT

printf 'Downloading Lody OSS LAN %s (%s)...\n' "$VERSION" "$arch"
curl -fL --retry 3 --progress-bar -o "$workdir/$asset" "$BASE_URL/$asset"
curl -fsSL --retry 3 -o "$workdir/SHA256SUMS" "$BASE_URL/SHA256SUMS"

expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$workdir/SHA256SUMS")"
[ -n "$expected" ] || fail "the release lists no checksum for $asset"
actual="$(shasum -a 256 "$workdir/$asset" | awk '{ print $1 }')"
# A mismatch usually means a newer build is being published right now.
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset; retry in a few minutes"

ditto -x -k "$workdir/$asset" "$workdir/unpacked"
[ -d "$workdir/unpacked/$APPLICATION_NAME" ] || fail "$asset does not contain $APPLICATION_NAME"

target="$INSTALL_DIR/$APPLICATION_NAME"
if pgrep -f "$target/Contents/MacOS/" >/dev/null 2>&1; then
  fail "Lody OSS is running; quit it and run this command again"
fi

rm -rf "$target"
ditto "$workdir/unpacked/$APPLICATION_NAME" "$target"
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true

printf 'Installed %s\n' "$target"
printf 'Open it and add a LAN in Settings, or start it with: open -a "Lody OSS"\n'
