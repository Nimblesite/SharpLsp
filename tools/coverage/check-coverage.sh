#!/usr/bin/env bash
# agent-pmo:2efd847
# Backward-compatible POSIX entry point. The implementation is Node-based so
# the Make targets also work from PowerShell + Git for Windows without jq/bc.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/check-coverage.mjs" "$@"
