#!/usr/bin/env bash
# Implements the isolation half of [DIST-CI-WIN-VSIX] / [DIST-CI-SMOKE].
#
# Deletes any SharpLsp component that has leaked onto the runner's PATH, so the
# VS Code test host can only resolve the freshly-staged BUNDLED binaries. A dev
# copy on PATH silently substitutes itself for the artifact under test and turns
# a broken bundle into a green build.
set -euo pipefail

for binary in sharplsp sharplsp-sidecar-csharp sharplsp-sidecar-fsharp; do
  resolved="$(command -v "$binary" || true)"
  if [ -n "$resolved" ]; then
    echo "Removing PATH-installed $binary at $resolved"
    rm -f "$resolved"
  fi
done
