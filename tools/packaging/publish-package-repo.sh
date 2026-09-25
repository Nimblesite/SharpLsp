#!/usr/bin/env sh
# Commit a rendered package file into an already-checked-out tap/bucket repo and
# push it. [DIST-PATH-INSTALL]
#
# Usage: tools/packaging/publish-package-repo.sh <repo-dir> <src-file> <dest-path> <message>
#
#   repo-dir    working copy of the target repo (actions/checkout with a token)
#   src-file    rendered file to publish
#   dest-path   path within repo-dir, e.g. Formula/sharplsp.rb
#   message     commit message
#
# Shared by the Homebrew and Scoop publish jobs, which differ only in those four
# values. A no-op re-run exits 0: re-running a release job after a partial
# failure must not fail on "nothing to commit".
set -eu

[ "$#" -eq 4 ] || {
    echo "usage: $0 <repo-dir> <src-file> <dest-path> <message>" >&2
    exit 2
}

repo_dir="$1"
src_file="$2"
dest_path="$3"
message="$4"

[ -d "$repo_dir/.git" ] || {
    echo "ERROR: $repo_dir is not a git working copy" >&2
    exit 1
}
[ -s "$src_file" ] || {
    echo "ERROR: $src_file is missing or empty" >&2
    exit 1
}

mkdir -p "$repo_dir/$(dirname -- "$dest_path")"
cp "$src_file" "$repo_dir/$dest_path"

cd "$repo_dir"
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add "$dest_path"
if git diff --staged --quiet; then
    echo "==> $dest_path already up to date; nothing to push."
    exit 0
fi
git commit -m "$message"
git push
echo "==> Pushed $dest_path — $message"
