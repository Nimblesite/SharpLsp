#!/usr/bin/env bash
set -euo pipefail

echo "==> Post-create setup for SharpLsp development..."

# Rust components
rustup component add clippy rustfmt llvm-tools-preview
cargo install cargo-llvm-cov

# .NET tools
dotnet tool restore

# VS Code extension dependencies
cd src/editors/vscode && npm ci && cd ../../..

echo "==> Setup complete."
