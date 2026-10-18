#!/bin/bash
# Run in a dedicated clone on an Apple Silicon Mac:
#   bash scripts/mac-local-test-build.sh
# Requires Xcode command-line tools, the repository's Node version and Corepack.
# Quit Lody Test first. Keeps pnpm/build caches; merges origin/lan-hub into the
# current branch without resetting local work. Resolve any merge conflict normally.
# Produces apps/electron/dist/local-test/mac-arm64/Lody Test.app and opens it.
# Runtime data: ~/.lody-test; desktop data: ~/Library/Application Support/Lody Test
# No LAN credentials are copied. Joining a LAN shares live writable data, not a snapshot.
# No tag, release, push, developer signing, notarization or DMG is produced.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -sm)" != 'Darwin arm64' ]]; then
  echo 'This build requires an Apple Silicon Mac.' >&2
  exit 1
fi
if pgrep -x 'Lody Test' >/dev/null; then
  echo 'Quit Lody Test before rebuilding it.' >&2
  exit 1
fi

started=$SECONDS
git fetch origin lan-hub
git merge --no-edit origin/lan-hub
git submodule update --init --recursive
node scripts/apply-submodule-patches.mjs
corepack pnpm install --frozen-lockfile

unset ELECTRON_RUN_AS_NODE
unset LODY_LAN_REPOSITORY LODY_LAN_TAG LODY_LAN_COMMIT
unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME LODY_MAC_SELF_SIGNED
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
export NODE_OPTIONS=--max-old-space-size=6144
export CSC_IDENTITY_AUTO_DISCOVERY=false
export LODY_MAC_LOCAL_TEST=1

# The normal CLI build runs prepare:acp-adapters before typecheck and bundling.
corepack pnpm --dir apps/electron build
corepack pnpm --dir apps/electron run package -- --mac --arm64 --dir --publish never

app="$PWD/apps/electron/dist/local-test/mac-arm64/Lody Test.app"
echo "Built $app in $((SECONDS - started)) seconds"
open "$app"
