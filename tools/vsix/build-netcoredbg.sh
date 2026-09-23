#!/usr/bin/env bash
# Build SharpLsp's DAP hot-reload extension and symbol-less stepping fix on
# the exact netcoredbg release commit. The patch exposes ICorDebug ApplyChanges
# and permits CLR stepping from exception frames without source sequence points.
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
PATCHES=("$ROOT/tools/netcoredbg/dap-hot-reload.patch" "$ROOT/tools/netcoredbg/exception-stepping.patch")
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
if [ "${2:-}" != "--rebuild" ] && [ -f "$EXE" ] && [ "$(cat "$MARKER" 2>/dev/null || true)" = "$BUILD_ID" ]; then
  echo "netcoredbg: patched build already available at $EXE"
  exit 0
fi

# macOS purges $TMPDIR by deleting files and leaving the directory tree, so a
# purged cache still has a `.git` directory that is no longer a repository. An
# empty shell is safe to rebuild; one still holding files is not ours to delete.
reset_purged_cache() {
  local destination="$1"
  [ -d "$destination" ] || return 0
  git --git-dir="$destination/.git" rev-parse --git-dir >/dev/null 2>&1 && return 0
  if [ -n "$(find "$destination" -type f -print -quit)" ]; then
    echo "netcoredbg: incomplete source cache at '$destination'; move it aside and retry" >&2
    exit 1
  fi
  rm -rf "$destination"
}

clone_commit() {
  local repository="$1"
  local commit="$2"
  local destination="$3"
  reset_purged_cache "$destination"
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

# [DIST-VSIX-REBUILD] Rebuild native objects AND the managed helper. A matching
# marker or warm CMake/MSBuild outputs do not satisfy a full VSIX rebuild.
if [ "${2:-}" = "--rebuild" ]; then
  rm -rf "$BUILD" "$OUTPUT" "$SOURCE/src/managed/bin" "$SOURCE/src/managed/obj"
fi

# [DIST-DEBUGGER-BUNDLE] Upstream mixes CRLF files (steppers.cpp) with LF ones
# (vscodeprotocol.cpp), and this repo stores every patch LF. Apply against
# line-ending-normalised content, never the runner's own core.autocrlf: under
# `false` (the Linux runner default) a CRLF target rejects an LF patch.
apply_patch() { git -C "$SOURCE" -c core.autocrlf=input apply "$@"; }

for patch in "${PATCHES[@]}"; do
  if apply_patch --check "$patch" 2>/dev/null; then
    apply_patch "$patch"
  elif ! apply_patch --reverse --check "$patch"; then
    echo "netcoredbg: $patch does not apply cleanly to $NETCOREDBG_COMMIT" >&2
    exit 1
  fi
done

DOTNET_EXE="$(command -v dotnet)"
DOTNET_DIR="${DOTNET_ROOT:-$(cd "$(dirname "$DOTNET_EXE")" && pwd)}"
if [ "$PLATFORM" = "win32-x64" ]; then
  DOTNET_DIR="$(cygpath -m "$DOTNET_DIR")"
fi
mkdir -p "$BUILD" "$OUTPUT"

# [DIST-DEBUGGER-BUNDLE] One `dotnet publish` of the managed part emits BOTH
# ManagedPart.dll and the platform's dbgshim library into the build directory,
# but CMake declares only the .dll as that custom command's OUTPUT. So a publish
# that half-ran - interrupted, or restored before the native asset resolved -
# leaves a build tree that is stuck for good: every later build skips the publish
# because the .dll is there, and `cmake --install` then dies on the dbgshim
# library that never arrived. Deleting the .dll is what makes CMake publish
# again; nothing else in the tree can express "this output is incomplete".
case "$PLATFORM" in
  darwin-*) DBGSHIM_LIB="libdbgshim.dylib" ;;
  win32-*)  DBGSHIM_LIB="dbgshim.dll" ;;
  *)        DBGSHIM_LIB="libdbgshim.so" ;;
esac
if [ -f "$BUILD/src/ManagedPart.dll" ] && [ ! -f "$BUILD/src/$DBGSHIM_LIB" ]; then
  echo "netcoredbg: cached managed part is missing $DBGSHIM_LIB; publishing it again"
  rm -f "$BUILD/src/ManagedPart.dll"
fi

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
