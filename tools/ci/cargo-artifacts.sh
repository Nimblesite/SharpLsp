#!/usr/bin/env bash
# [DIST-CI-ARTIFACT-TESTS] Build and execute are separate commands. The test
# command uses nextest's archive API, which cannot invoke a compiler.
# https://nexte.st/docs/ci-features/archiving/
set -euo pipefail
mode="${1:?build or test required}"
component="${2:?rust or zed required}"
shift 2
root="$(cd "$(dirname "$0")/../.." && pwd)"
case "$component" in
  rust) cd "$root" ;;
  zed) cd "$root/src/editors/zed" ;;
  *) echo "Unknown Cargo artifact: $component" >&2; exit 2 ;;
esac
archive="$root/target/$component-tests.tar.zst"
export CARGO_TARGET_DIR="$root/target/ci-$component-tests"
mkdir -p "$CARGO_TARGET_DIR"
# Use cargo-llvm-cov's supported external-build environment for BOTH halves.
eval "$(cargo llvm-cov show-env --sh)"
case "$mode" in
  build)
    cargo nextest archive --release --locked --archive-file "$archive"
    ;;
  test)
    test -s "$archive" || { echo "Missing same-run test archive: $archive" >&2; exit 1; }
    cargo llvm-cov clean --profraw-only
    cargo nextest run --archive-file "$archive" --workspace-remap "$PWD" \
      --extract-to "$CARGO_TARGET_DIR" --extract-overwrite \
      --no-fail-fast --retries 0 "$@"
    if [ "$component" = rust ]; then
      cargo llvm-cov report --nextest-archive-file "$archive" --lcov \
        --output-path "$root/target/coverage-rust-shard${SHARD:?SHARD required}.lcov"
    else
      cargo llvm-cov report --nextest-archive-file "$archive" --json \
        --output-path "$root/target/coverage-zed.json"
    fi
    ;;
  *) echo "Unknown artifact operation: $mode" >&2; exit 2 ;;
esac
