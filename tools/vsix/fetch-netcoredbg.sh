#!/usr/bin/env bash
# Stage SharpLsp's patched netcoredbg into the VS Code extension.
# Implements [DIST-DEBUGGER-BUNDLE].
#
# This script does NOT decide how the adapter is obtained. That is
# tools/netcoredbg/provide.mjs, which prefers the SHA-256-pinned artifact in
# netcoredbg.lock.json and only compiles from source when a platform has no
# pin. Releases must ship the pinned artifact so the bytes users debug with
# have attested provenance.
#
# netcoredbg is MIT-licensed (© 2017 Samsung Electronics Co., LTD) — attribution
# is in THIRD-PARTY-NOTICES.md. Platforms without a configured native build
# skip cleanly and fall back to PATH / sharplsp.debug.netcoredbgPath.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VSCODE_BIN="$ROOT/src/editors/vscode/bin"
PLATFORM="${1:-$(node -e "process.stdout.write(process.platform + '-' + process.arch)")}"

case "$PLATFORM" in
  win32-x64) EXE_EXT=".exe" ;;
  linux-x64|linux-arm64|darwin-arm64) EXE_EXT="" ;;
  win32-arm64|darwin-x64)
    echo "netcoredbg: no patched build for '$PLATFORM' — using configured/PATH fallback" >&2
    exit 0 ;;
  *)
    echo "netcoredbg: unknown platform '$PLATFORM'" >&2
    exit 1 ;;
esac

# An adapter is current only when its marker names the build the lock file
# describes. Existence is not enough: after a patchVersion bump, an adapter
# built from the previous lock still exists and lacks the new patch.
BUILD_ID="$(node "$ROOT/tools/netcoredbg/read-lock.mjs" buildId)"
is_current() {
  [ -f "$1/netcoredbg$EXE_EXT" ] &&
    [ "$(tr -d '\r\n' < "$1/.sharplsp-dap-hot-reload" 2>/dev/null || true)" = "$BUILD_ID" ]
}

DEST="$VSCODE_BIN/$PLATFORM"
EXE="$DEST/netcoredbg/netcoredbg$EXE_EXT"
if is_current "$DEST/netcoredbg"; then
  echo "netcoredbg: already staged at $EXE"
  exit 0
fi

# provide.mjs returns at once when target/ already holds this build.
BUILT="$ROOT/target/netcoredbg/$PLATFORM/netcoredbg"
node "$ROOT/tools/netcoredbg/provide.mjs" "$PLATFORM"
if ! is_current "$BUILT"; then
  echo "netcoredbg: patched build $BUILD_ID missing at $BUILT" >&2
  exit 1
fi

rm -rf "$DEST/netcoredbg"
mkdir -p "$DEST/netcoredbg"
cp -r "$BUILT/." "$DEST/netcoredbg/"
if [ ! -f "$EXE" ]; then
  echo "netcoredbg: expected binary at $EXE after staging; contents:" >&2
  ls -laR "$DEST" >&2
  exit 1
fi
chmod +x "$EXE" 2>/dev/null || true

echo "netcoredbg: staged patched adapter for $PLATFORM -> $EXE"
"$EXE" --version 2>&1 | head -2 || echo "netcoredbg: (binary staged; --version not run)"
