#!/usr/bin/env bash
#
# Build the Forge LSP server (Rust) and package the VS Code extension (.vsix).
#
# Usage:
#   ./scripts/build-vsix.sh            # release build
#   ./scripts/build-vsix.sh --debug    # debug build (faster compilation)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VSCODE_DIR="${REPO_ROOT}/editors/vscode"

CARGO_PROFILE="release"
if [[ "${1:-}" == "--debug" ]]; then
    CARGO_PROFILE="debug"
fi

echo "==> Building forge-lsp (${CARGO_PROFILE})..."
if [[ "${CARGO_PROFILE}" == "release" ]]; then
    cargo build --release --manifest-path "${REPO_ROOT}/Cargo.toml"
else
    cargo build --manifest-path "${REPO_ROOT}/Cargo.toml"
fi

BINARY="${REPO_ROOT}/target/${CARGO_PROFILE}/forge-lsp"
if [[ ! -f "${BINARY}" ]]; then
    echo "ERROR: Expected binary not found at ${BINARY}" >&2
    exit 1
fi
echo "==> Binary: ${BINARY}"

echo "==> Building C# sidecar..."
DOTNET_CONFIG="Release"
if [[ "${CARGO_PROFILE}" == "debug" ]]; then
    DOTNET_CONFIG="Debug"
fi
dotnet publish "${REPO_ROOT}/sidecars/Forge.Sidecar.CSharp/Forge.Sidecar.CSharp.csproj" \
    --configuration "${DOTNET_CONFIG}" \
    --output "${REPO_ROOT}/target/sidecar-csharp" \
    --self-contained false

echo "==> Bundling binaries into extension..."
mkdir -p "${VSCODE_DIR}/bin"
cp "${BINARY}" "${VSCODE_DIR}/bin/forge-lsp"
chmod +x "${VSCODE_DIR}/bin/forge-lsp"

# Bundle sidecar assemblies.
cp -r "${REPO_ROOT}/target/sidecar-csharp" "${VSCODE_DIR}/bin/sidecar-csharp"

echo "==> Installing VS Code extension dependencies..."
npm ci --prefix "${VSCODE_DIR}"

echo "==> Bundling extension with esbuild..."
npm run build --prefix "${VSCODE_DIR}"

echo "==> Packaging .vsix..."
(cd "${VSCODE_DIR}" && npx @vscode/vsce package \
    --no-dependencies \
    -o "${REPO_ROOT}/forge.vsix")

echo "==> Done. VSIX written to ${REPO_ROOT}/forge.vsix"
