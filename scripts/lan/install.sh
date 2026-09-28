#!/usr/bin/env bash
# Installs the Lody OSS LAN command line on a server, and sets the server up in
# the same step when asked to.
#
#   Host a LAN on this machine, and run agents on it:
#     curl -fsSL https://github.com/__LODY_LAN_REPOSITORY__/releases/download/__LODY_LAN_TAG__/install.sh | bash -s -- up
#
#   Join a LAN with the invite its host printed:
#     curl -fsSL https://github.com/__LODY_LAN_REPOSITORY__/releases/download/__LODY_LAN_TAG__/install.sh | bash -s -- join lody-lan://…
#
#   Only install or update the command line:
#     curl -fsSL https://github.com/__LODY_LAN_REPOSITORY__/releases/download/__LODY_LAN_TAG__/install.sh | bash
#
# Everything after `up` or `join` is passed on, so `up --name Home --port 9000`
# works. Run the same command again to update: it keeps the LANs and restarts
# the services with the new build.
set -euo pipefail

REPOSITORY="__LODY_LAN_REPOSITORY__"
TAG="__LODY_LAN_TAG__"
VERSION="__LODY_LAN_VERSION__"
BASE_URL="${LODY_LAN_BASE_URL:-https://github.com/${REPOSITORY}/releases/download/${TAG}}"
INSTALL_ROOT="${LODY_LAN_INSTALL_ROOT:-${HOME}/.local/share/lody-lan}"
BIN_DIR="${LODY_LAN_BIN_DIR:-${HOME}/.local/bin}"
COMMAND_NAME="lody-lan"
ASSET="lody-lan-cli.tgz"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"
}

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

action="${1:-}"
case "$action" in
  "" | up | join) ;;
  *) fail "unknown action \"$action\"; use up, join <invite>, or nothing to only install" ;;
esac
[ "$action" != "join" ] || [ "$#" -ge 2 ] || fail "join needs the invite of the LAN"

need curl
need node
need npm
command -v sha256sum >/dev/null 2>&1 || need shasum

# The SQLite binding of the command line needs Node-API 10.
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit((major === 22 && minor >= 14) || (major === 23 && minor >= 6) || major >= 24 ? 0 : 1);
' || fail "Node.js $(node -p process.versions.node) is too old; 22.14 or newer is required"

workdir="$(mktemp -d "${TMPDIR:-/tmp}/lody-lan-install.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT

printf 'Downloading Lody OSS LAN %s...\n' "$VERSION"
curl -fsSL --retry 3 -o "$workdir/$ASSET" "$BASE_URL/$ASSET"
curl -fsSL --retry 3 -o "$workdir/SHA256SUMS" "$BASE_URL/SHA256SUMS"

expected="$(awk -v name="$ASSET" '$2 == name { print $1 }' "$workdir/SHA256SUMS")"
[ -n "$expected" ] || fail "the release lists no checksum for $ASSET"
# A mismatch usually means a newer build is being published right now.
[ "$expected" = "$(checksum "$workdir/$ASSET")" ] ||
  fail "checksum mismatch for $ASSET; retry in a few minutes"

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
# The directory is a package of its own, so npm installs into it and not into
# a project it finds further up.
[ -f "$INSTALL_ROOT/package.json" ] ||
  printf '{\n  "name": "lody-lan-install",\n  "private": true\n}\n' >"$INSTALL_ROOT/package.json"

printf 'Installing into %s...\n' "$INSTALL_ROOT"
npm install \
  --prefix "$INSTALL_ROOT" \
  --no-audit --no-fund --omit=dev --loglevel=error \
  "$workdir/$ASSET" >/dev/null

entry="$INSTALL_ROOT/node_modules/lody/dist/index.js"
[ -f "$entry" ] || fail "the installed package has no entry at $entry"

launcher="$BIN_DIR/$COMMAND_NAME"
runtime="$(command -v node)"
cat >"$launcher" <<LAUNCHER
#!/usr/bin/env bash
# Written by the Lody OSS LAN installer.
# The two names let the command line print commands that work as printed.
export LODY_LAN_COMMAND="$COMMAND_NAME"
export LODY_LAN_INSTALLER="$BASE_URL/install.sh"
exec "$runtime" "$entry" "\$@"
LAUNCHER
chmod 755 "$launcher"

installed="$("$launcher" --version)"
printf 'Installed %s %s as %s\n' "$COMMAND_NAME" "$installed" "$launcher"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH to run %s from anywhere.\n' "$BIN_DIR" "$COMMAND_NAME" ;;
esac

# Services that were set up before keep running the build they started with.
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user try-restart lody-lan-hub.service lody-lan-agent.service 2>/dev/null || true
fi

case "$action" in
  up)
    shift
    exec "$launcher" lan up "$@"
    ;;
  join)
    shift
    exec "$launcher" lan join "$@" --service
    ;;
esac
