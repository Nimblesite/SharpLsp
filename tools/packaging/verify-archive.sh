#!/usr/bin/env sh
# Verify a standalone server archive in dist/. [DIST-ARCHIVE] [DIST-CI-SMOKE]
#
# Usage: tools/packaging/verify-archive.sh <platform> [expected-version]
#
# Environment:
#   SKIP_RUN=1   list-only; skip the unpack-and-execute smoke test. Set for a
#                cross-compiled target the runner cannot execute.
#
# Two checks, because neither alone is sufficient:
#
#   1. LAYOUT. The archive has no extension wrapping it and no shipwright to
#      hand the host explicit paths, so `sharplsp` must find its sidecars by
#      the layout alone — `installed_sidecar_exe` layout 1 in
#      src/sharplsp/src/sidecar/manager.rs, `<exe_dir>/<subdir>/<name>`. A
#      rename or a moved directory breaks every non-VS-Code editor while every
#      VSIX check stays green, so the exact paths are asserted here.
#
#   2. EXECUTION. A .NET apphost is only a launcher: strip the managed assembly
#      from beside it and the executable still EXISTS but cannot start. No
#      listing detects that, so the archive is unpacked and all three binaries
#      are run. Mirrors VERIFY_STAGED_SIDECARS, which guards the same failure
#      for the VSIX stage.
set -eu

[ "$#" -ge 1 ] || {
    echo "usage: $0 <platform> [expected-version]" >&2
    exit 2
}

plat="$1"
expected_version="${2:-}"

case "$plat" in
win32-*)
    archive="dist/sharplsp-${plat}.zip"
    exe=".exe"
    ;;
*)
    archive="dist/sharplsp-${plat}.tar.gz"
    exe=""
    ;;
esac

[ -s "$archive" ] || {
    echo "ERROR: $archive is missing or empty" >&2
    exit 1
}

list_entries() {
    case "$archive" in
    *.zip) unzip -Z1 "$archive" ;;
    *) tar -tzf "$archive" ;;
    esac
}

entries="$(list_entries)"
for want in \
    "sharplsp-${plat}/sharplsp${exe}" \
    "sharplsp-${plat}/sidecar-csharp/SharpLsp.Sidecar.CSharp${exe}" \
    "sharplsp-${plat}/sidecar-csharp/SharpLsp.Sidecar.CSharp.dll" \
    "sharplsp-${plat}/sidecar-fsharp/SharpLsp.Sidecar.FSharp${exe}" \
    "sharplsp-${plat}/sidecar-fsharp/SharpLsp.Sidecar.FSharp.dll"; do
    printf '%s\n' "$entries" | grep -Fxq "$want" || {
        echo "ERROR: $archive is missing $want" >&2
        exit 1
    }
done
echo "==> $archive layout verified."

if [ -n "${SKIP_RUN:-}" ]; then
    echo "==> Skipping execution smoke test (SKIP_RUN set)."
    exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
case "$archive" in
*.zip) unzip -q "$archive" -d "$work" ;;
*) tar -xzf "$archive" -C "$work" ;;
esac

root="$work/sharplsp-${plat}"
csharp="$root/sidecar-csharp/SharpLsp.Sidecar.CSharp${exe}"
fsharp="$root/sidecar-fsharp/SharpLsp.Sidecar.FSharp${exe}"
# zip carries no POSIX mode bits, and download-artifact drops the +x that the
# build produced, so restore it rather than failing with "Permission denied".
chmod +x "$root/sharplsp${exe}" "$csharp" "$fsharp" 2>/dev/null || true

version_line="$("$root/sharplsp${exe}" --version)"
echo "    $version_line"
if [ -n "$expected_version" ] && [ "$version_line" != "sharplsp ${expected_version}" ]; then
    echo "ERROR: expected 'sharplsp ${expected_version}', got '${version_line}'" >&2
    exit 1
fi
echo "    $("$csharp" --version)"
echo "    $("$fsharp" --version)"
echo "==> $archive runs unpacked."
