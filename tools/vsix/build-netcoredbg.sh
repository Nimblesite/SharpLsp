#!/usr/bin/env bash
# Build SharpLsp's minimal DAP hot-reload extension on the exact netcoredbg
# release commit. The patch only exposes netcoredbg's existing, tested
# ICorDebug ApplyChanges implementation to its VS Code protocol.
set -euo pipefail

# [DIST-DEBUGGER-BUNDLE] The commits and the patch version live in
# tools/netcoredbg/netcoredbg.lock.json, which is also what pins the SHA-256
# of the published artifacts. Read them from there rather than keeping a
# second copy here that can drift out of step with the pins.
LOCK_READER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../netcoredbg" && pwd)/read-lock.mjs"
NETCOREDBG_COMMIT="$(node "$LOCK_READER" netcoredbgCommit)"
CORECLR_COMMIT="$(node "$LOCK_READER" coreclrCommit)"
BUILD_ID="$(node "$LOCK_READER" buildId)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLATFORM="${1:-$(node -e "process.stdout.write(process.platform + '-' + process.arch)")}"
HOST_PLATFORM="$(node -e "process.stdout.write(process.platform + '-' + process.arch)")"
PATCH="$ROOT/tools/netcoredbg/dap-hot-reload.patch"
CACHE_ROOT="${NETCOREDBG_BUILD_CACHE_DIR:-${TMPDIR:-/tmp}/sharplsp-netcoredbg-build/$PLATFORM}"
SOURCE="$CACHE_ROOT/source"
CORECLR="$CACHE_ROOT/coreclr"
BUILD="$CACHE_ROOT/build"
OUTPUT="$ROOT/target/netcoredbg/$PLATFORM/netcoredbg"
EXE_EXT=""

case "$PLATFORM" in
  win32-x64) EXE_EXT=".exe" ;;
  linux-x64|linux-arm64|darwin-arm64) ;;
  win32-arm64|darwin-x64)
    echo "netcoredbg: no SharpLsp source build is configured for '$PLATFORM'" >&2
    exit 0 ;;
  *)
    echo "netcoredbg: unknown platform '$PLATFORM'" >&2
    exit 1 ;;
esac

if [ "$PLATFORM" != "$HOST_PLATFORM" ]; then
  echo "netcoredbg: '$PLATFORM' needs a matching runner (host is '$HOST_PLATFORM')" >&2
  exit 1
fi

EXE="$OUTPUT/netcoredbg$EXE_EXT"
MARKER="$OUTPUT/.sharplsp-dap-hot-reload"
if [ -f "$EXE" ] && [ "$(cat "$MARKER" 2>/dev/null || true)" = "$BUILD_ID" ]; then
  echo "netcoredbg: patched build already available at $EXE"
  exit 0
fi

clone_commit() {
  local repository="$1"
  local commit="$2"
  local destination="$3"
  if [ ! -d "$destination/.git" ]; then
    if [ -e "$destination" ]; then
      echo "netcoredbg: incomplete source cache at '$destination'; move it aside and retry" >&2
      exit 1
    fi
    mkdir -p "$destination"
    git -C "$destination" init --quiet
    git -C "$destination" remote add origin "$repository"
    git -C "$destination" fetch --quiet --depth 1 origin "$commit"
    git -C "$destination" checkout --quiet --detach FETCH_HEAD
  fi
  local actual
  actual="$(git -C "$destination" rev-parse HEAD)"
  if [ "$actual" != "$commit" ]; then
    echo "netcoredbg: cache '$destination' is $actual, expected $commit" >&2
    exit 1
  fi
}

clone_commit "https://github.com/Samsung/netcoredbg.git" "$NETCOREDBG_COMMIT" "$SOURCE"
clone_commit "https://github.com/dotnet/runtime.git" "$CORECLR_COMMIT" "$CORECLR"

if git -C "$SOURCE" apply --check "$PATCH" 2>/dev/null; then
  git -C "$SOURCE" apply "$PATCH"
elif ! git -C "$SOURCE" apply --reverse --check "$PATCH"; then
  echo "netcoredbg: hot-reload patch does not apply cleanly to $NETCOREDBG_COMMIT" >&2
  exit 1
fi

DOTNET_EXE="$(command -v dotnet)"
DOTNET_DIR="${DOTNET_ROOT:-$(cd "$(dirname "$DOTNET_EXE")" && pwd)}"
if [ "$PLATFORM" = "win32-x64" ]; then
  DOTNET_DIR="$(cygpath -m "$DOTNET_DIR")"
fi
mkdir -p "$BUILD" "$OUTPUT"

CMAKE_ARGS=(
  -S "$SOURCE"
  -B "$BUILD"
  -DCORECLR_DIR="$CORECLR/src/coreclr"
  -DDOTNET_DIR="$DOTNET_DIR"
  -DCMAKE_INSTALL_PREFIX="$OUTPUT"
  -DCMAKE_BUILD_TYPE=Release
)
if [ "$PLATFORM" = "win32-x64" ]; then
  cmake "${CMAKE_ARGS[@]}" -A x64
else
  CC="${CC:-clang}" CXX="${CXX:-clang++}" cmake "${CMAKE_ARGS[@]}"
fi
cmake --build "$BUILD" --config Release --parallel
cmake --install "$BUILD" --config Release

if [ ! -f "$EXE" ]; then
  echo "netcoredbg: build completed without expected executable '$EXE'" >&2
  exit 1
fi
chmod +x "$EXE" 2>/dev/null || true
printf '%s\n' "$BUILD_ID" > "$MARKER"
echo "netcoredbg: built patched $PLATFORM adapter at $EXE"
"$EXE" --version 2>&1 | head -2 || true
