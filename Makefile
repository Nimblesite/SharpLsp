# Forge build system
#
# Usage:
#   make                     build everything (release)
#   make PROFILE=debug       build everything (debug)
#   make build-rust          forge-lsp binary only
#   make build-dotnet        C# sidecar only
#   make build-vsix          VS Code extension (pulls in build-rust + build-dotnet)
#   make build-zed           Zed extension WASM only
#   make test                run all tests
#   make lint                build + lint ALL languages (Rust, TypeScript, .NET)
#   make fmt                 format ALL languages (Rust, TypeScript, .NET)
#   make clean               remove build artifacts

# Fail fast: any error in any command or pipeline = immediate abort.
SHELL := /bin/bash
.SHELLFLAGS := -eo pipefail -c

.PHONY: build build-rust build-dotnet build-vsix build-zed \
       test test-rust test-zed test-vsix \
       lint lint-rust lint-zed lint-vsix lint-dotnet \
       fmt fmt-rust fmt-zed fmt-vsix fmt-dotnet clean

PROFILE    ?= release
CARGO_FLAG  = $(if $(filter release,$(PROFILE)),--release,)
DOTNET_CFG  = $(if $(filter release,$(PROFILE)),Release,Debug)

# ── Directories ──────────────────────────────────────────────────

VSCODE_DIR  = editors/vscode
ZED_DIR     = editors/zed
SIDECAR_DIR = sidecars/Forge.Sidecar.CSharp
SIDECAR_SLN = sidecars/Forge.Sidecars.sln

# ── Outputs ──────────────────────────────────────────────────────

BINARY      = target/$(PROFILE)/forge-lsp
SIDECAR_OUT = target/sidecar-csharp
ZED_WASM    = $(ZED_DIR)/target/wasm32-wasip1/$(PROFILE)/forge_zed.wasm
VSIX        = forge.vsix

# ── Default target ───────────────────────────────────────────────

build: build-rust build-dotnet build-vsix build-zed
	@echo ""
	@echo "==> Build complete."
	@echo "    Server:  $(BINARY)"
	@echo "    Sidecar: $(SIDECAR_OUT)"
	@echo "    VSIX:    $(VSIX)"
	@echo "    Zed:     $(ZED_WASM)"

# ── Rust LSP server (native) ────────────────────────────────────

build-rust:
	@echo "==> Building forge-lsp ($(PROFILE))..."
	cargo build $(CARGO_FLAG)
	@test -f $(BINARY) || { echo "ERROR: $(BINARY) not found" >&2; exit 1; }
	@echo "==> Binary: $(BINARY)"

# ── .NET C# sidecar ─────────────────────────────────────────────

build-dotnet:
	@echo "==> Building C# sidecar ($(DOTNET_CFG))..."
	dotnet publish $(SIDECAR_DIR)/Forge.Sidecar.CSharp.csproj \
		--configuration $(DOTNET_CFG) \
		--output $(SIDECAR_OUT) \
		--self-contained false

# ── VS Code extension (.vsix) ───────────────────────────────────

build-vsix: build-rust build-dotnet
	@echo "==> Bundling binaries into VS Code extension..."
	@mkdir -p $(VSCODE_DIR)/bin
	cp $(BINARY) $(VSCODE_DIR)/bin/forge-lsp
	chmod +x $(VSCODE_DIR)/bin/forge-lsp
	cp -r $(SIDECAR_OUT) $(VSCODE_DIR)/bin/sidecar-csharp
	@echo "==> Installing VS Code extension dependencies..."
	npm ci --prefix $(VSCODE_DIR)
	@echo "==> Bundling extension with esbuild..."
	npm run build --prefix $(VSCODE_DIR)
	@echo "==> Packaging .vsix..."
	cd $(VSCODE_DIR) && npx @vscode/vsce package --no-dependencies -o ../../$(VSIX)
	@echo "==> VSIX: $(VSIX)"

# ── Zed extension (Rust → WASM) ─────────────────────────────────

build-zed:
	@echo "==> Building Zed extension (wasm32-wasip1, $(PROFILE))..."
	@rustup target list --installed | grep -q wasm32-wasip1 \
		|| { echo "==> Installing wasm32-wasip1 target..."; rustup target add wasm32-wasip1; }
	cargo build $(CARGO_FLAG) \
		--manifest-path $(ZED_DIR)/Cargo.toml \
		--target wasm32-wasip1
	@test -f $(ZED_WASM) || { echo "ERROR: $(ZED_WASM) not found" >&2; exit 1; }
	@echo "==> Zed WASM: $(ZED_WASM)"

# ── Tests ────────────────────────────────────────────────────────

test: test-rust test-zed

test-rust:
	@echo "==> Running forge-lsp tests..."
	cargo test

test-zed:
	@echo "==> Running Zed extension tests..."
	cargo test --manifest-path $(ZED_DIR)/Cargo.toml

test-vsix:
	@echo "==> Running VS Code extension tests..."
	npm test --prefix $(VSCODE_DIR)

# ── Lint (all languages — includes build) ────────────────────────

lint: build lint-rust lint-zed lint-vsix lint-dotnet
	@echo ""
	@echo "==> All lints passed."

lint-rust:
	@echo "==> [Rust] Clippy (forge-lsp)..."
	cargo clippy $(CARGO_FLAG) -- -D warnings
	@echo "==> [Rust] Rustfmt check (forge-lsp)..."
	cargo fmt --check

lint-zed:
	@echo "==> [Rust] Clippy (Zed extension)..."
	cargo clippy --manifest-path $(ZED_DIR)/Cargo.toml -- -D warnings
	@echo "==> [Rust] Rustfmt check (Zed extension)..."
	cargo fmt --check --manifest-path $(ZED_DIR)/Cargo.toml

lint-vsix:
	@echo "==> [TypeScript] ESLint (VS Code extension)..."
	npm run lint:eslint --prefix $(VSCODE_DIR)
	@echo "==> [TypeScript] tsc --noEmit (VS Code extension)..."
	npm run typecheck --prefix $(VSCODE_DIR)

lint-dotnet:
	@echo "==> [.NET] Build with TreatWarningsAsErrors (sidecars)..."
	dotnet build $(SIDECAR_SLN) \
		--configuration $(DOTNET_CFG) \
		-warnaserror

# ── Formatting ───────────────────────────────────────────────────

fmt: fmt-rust fmt-zed fmt-vsix fmt-dotnet
	@echo ""
	@echo "==> All formatting complete."

fmt-rust:
	@echo "==> [Rust] Formatting forge-lsp..."
	cargo fmt

fmt-zed:
	@echo "==> [Rust] Formatting Zed extension..."
	cargo fmt --manifest-path $(ZED_DIR)/Cargo.toml

fmt-vsix:
	@echo "==> [TypeScript] Formatting VS Code extension..."
	cd $(VSCODE_DIR) && npx eslint --fix src/

fmt-dotnet:
	@echo "==> [.NET] Formatting sidecars..."
	dotnet format $(SIDECAR_SLN)

# ── Clean ────────────────────────────────────────────────────────

clean:
	@echo "==> Cleaning all build artifacts..."
	cargo clean
	cargo clean --manifest-path $(ZED_DIR)/Cargo.toml
	rm -rf $(VSCODE_DIR)/bin $(VSCODE_DIR)/dist $(VSCODE_DIR)/out
	rm -f $(VSIX)
	@echo "==> Clean."
