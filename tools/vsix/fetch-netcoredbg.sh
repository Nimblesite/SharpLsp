#!/usr/bin/env bash
# Fetch the netcoredbg debug adapter and stage it into the VS Code extension's
# bin/ dir so it ships inside the VSIX. Implements [DIST-DEBUGGER-BUNDLE].
#
# netcoredbg is MIT-licensed (© 2017 Samsung Electronics Co., LTD) — attribution
# is in THIRD-PARTY-NOTICES.md. Upstream ships prebuilt binaries for a subset of
# platforms; the two without a prebuilt (win32-arm64, darwin-x64) skip cleanly
# and fall back at runtime to a PATH copy / the sharplsp.debug.netcoredbgPath
# setting (see src/editors/vscode/src/debug.ts).
set -euo pipefail

# Pinned deliberately: a floating "latest" would silently change the bundled
# debugger. Bump in lockstep with THIRD-PARTY-NOTICES.md.
NETCOREDBG_VERSION="3.2.0-1092"
REPO="Samsung/netcoredbg"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VSCODE_BIN="$ROOT/src/editors/vscode/bin"

# VS Code platform id: "<platform>-<arch>". Default to the host platform.
PLATFORM="${1:-$(node -e "process.stdout.write(process.platform + '-' + process.arch)")}"

case "$PLATFORM" in
  win32-x64)    ASSET="netcoredbg-win64.zip";        KIND="zip"; EXE_EXT=".exe" ;;
  linux-x64)    ASSET="netcoredbg-linux-amd64.tar.gz"; KIND="tar"; EXE_EXT="" ;;
  linux-arm64)  ASSET="netcoredbg-linux-arm64.tar.gz"; KIND="tar"; EXE_EXT="" ;;
  darwin-arm64) ASSET="netcoredbg-osx-arm64.zip";    KIND="zip"; EXE_EXT="" ;;
  win32-arm64|darwin-x64)
    echo "netcoredbg: no upstream prebuilt for '$PLATFORM' — debugging will fall back to PATH / sharplsp.debug.netcoredbgPath" >&2
    exit 0 ;;
  *)
    echo "netcoredbg: unknown platform '$PLATFORM'" >&2
    exit 1 ;;
esac

DEST="$VSCODE_BIN/$PLATFORM"
EXE="$DEST/netcoredbg/netcoredbg$EXE_EXT"

if [ -f "$EXE" ]; then
  echo "netcoredbg: already staged at $EXE"
  exit 0
fi

URL="https://github.com/$REPO/releases/download/$NETCOREDBG_VERSION/$ASSET"

# Cache the archive (keyed by version+asset) so repeated staging — e.g. CI's
# seven Windows feature chunks, which each re-stage bin/ — downloads it once.
CACHE_DIR="${NETCOREDBG_CACHE_DIR:-$ROOT/target/netcoredbg-cache}"
ARCHIVE="$CACHE_DIR/$NETCOREDBG_VERSION-$ASSET"
mkdir -p "$CACHE_DIR"
if [ ! -f "$ARCHIVE" ]; then
  echo "netcoredbg: downloading $URL"
  curl -fsSL "$URL" -o "$ARCHIVE.tmp"
  mv "$ARCHIVE.tmp" "$ARCHIVE"
else
  echo "netcoredbg: using cached $ARCHIVE"
fi

mkdir -p "$DEST"
case "$KIND" in
  zip) unzip -q -o "$ARCHIVE" -d "$DEST" ;;
  tar) tar -xzf "$ARCHIVE" -C "$DEST" ;;
esac

# Upstream archives extract a top-level `netcoredbg/` directory.
if [ ! -f "$EXE" ]; then
  echo "netcoredbg: expected binary at $EXE after extraction; contents:" >&2
  ls -laR "$DEST" >&2
  exit 1
fi
chmod +x "$EXE" 2>/dev/null || true

echo "netcoredbg: staged for $PLATFORM -> $EXE"
"$EXE" --version 2>&1 | head -2 || echo "netcoredbg: (binary staged; --version not run)"
