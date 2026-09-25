#!/usr/bin/env sh
# Create a release archive from a staged directory. [DIST-ARCHIVE]
#
# Usage: tools/packaging/archive.sh <parent-dir> <entry> <output>
#
#   parent-dir  directory that CONTAINS the tree to archive
#   entry       name of the tree inside parent-dir (becomes the archive root)
#   output      archive path; the extension selects the format
#               (.tar.gz → gzipped tar, .zip → zip)
#
# `.tar.gz` is produced with tar, which exists on every runner and every
# developer machine we build on. `.zip` has no such single tool: GNU `zip` is
# absent from GitHub's Windows images and 7-Zip is absent from most Linux
# images, so the writer is probed rather than assumed. Windows 10 1803+ and
# macOS ship bsdtar, whose `-a` infers zip from the extension; that is the last
# resort so a machine with neither `zip` nor `7z` still produces a release
# asset instead of failing the tag build.
set -eu

[ "$#" -eq 3 ] || {
    echo "usage: $0 <parent-dir> <entry> <output>" >&2
    exit 2
}

parent="$1"
entry="$2"
output="$3"

[ -d "$parent/$entry" ] || {
    echo "ERROR: nothing staged at $parent/$entry" >&2
    exit 1
}

mkdir -p "$(dirname -- "$output")"
abs_output="$(CDPATH='' cd -- "$(dirname -- "$output")" && pwd)/$(basename -- "$output")"
rm -f "$abs_output"

case "$output" in
*.tar.gz)
    tar -czf "$abs_output" -C "$parent" "$entry"
    ;;
*.zip)
    if command -v zip >/dev/null 2>&1; then
        (cd "$parent" && zip -qr "$abs_output" "$entry")
    elif command -v 7z >/dev/null 2>&1; then
        (cd "$parent" && 7z a -tzip -bso0 -bsp0 "$abs_output" "$entry")
    elif tar --version 2>&1 | grep -q bsdtar; then
        tar -a -cf "$abs_output" -C "$parent" "$entry"
    else
        echo "ERROR: no zip writer found (tried zip, 7z, bsdtar)" >&2
        exit 1
    fi
    ;;
*)
    echo "ERROR: unsupported archive extension: $output" >&2
    exit 1
    ;;
esac

[ -s "$abs_output" ] || {
    echo "ERROR: $abs_output was not written" >&2
    exit 1
}
echo "==> $output ready."
