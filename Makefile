# Forge build system
#
# Usage:
#   make                     build everything (release)
#   make PROFILE=debug       build everything (debug)
#   make ci                  build → lint → test (with coverage thresholds) — the full pipeline
#   make build-rust          forge-lsp binary only
#   make build-dotnet        C# sidecar only
#   make build-vsix          VS Code extension (no binaries — thin client only)
#   make build-zed           Zed extension WASM only
#   make test                run all tests (with coverage + threshold enforcement)
#   make test-rust           test forge-lsp + coverage threshold
#   make test-vsix           test VS Code extension + coverage threshold
#   make lint                build + lint ALL languages (Rust, TypeScript, .NET)
#   make fmt                 format ALL languages (Rust, TypeScript, .NET)
#   make install              install forge-lsp to ~/.local/bin, sidecars to ~/.local/lib/forge/
#   make rebuild-vsix         clean + rebuild everything + package VSIX
#   make clean               remove build artifacts

# Fail fast: any error in any command or pipeline = immediate abort.
SHELL := /bin/bash
.SHELLFLAGS := -eo pipefail -c

.PHONY: ci build build-rust build-dotnet build-vsix build-zed \
       test test-rust test-zed test-vsix test-dotnet \
       lint lint-rust lint-zed lint-vsix lint-dotnet \
       fmt fmt-rust fmt-zed fmt-vsix fmt-dotnet install clean \
       rebuild-vsix fresh-vsix

PROFILE    ?= release
CARGO_FLAG  = $(if $(filter release,$(PROFILE)),--release,)
DOTNET_CFG  = $(if $(filter release,$(PROFILE)),Release,Debug)

# ── Directories ──────────────────────────────────────────────────

VSCODE_DIR  = editors/vscode
ZED_DIR     = editors/zed
SIDECAR_CS  = sidecars/Forge.Sidecar.CSharp
SIDECAR_FS  = sidecars/Forge.Sidecar.FSharp
WEBSITE_DIR = website
PLUGIN_DIR  = website/eleventy-plugin-techdoc
SIDECAR_SLN = sidecars/Forge.Sidecars.sln

# ── Outputs ──────────────────────────────────────────────────────

BINARY         = target/$(PROFILE)/forge-lsp
SIDECAR_CS_OUT = target/sidecar-csharp
SIDECAR_FS_OUT = target/sidecar-fsharp
ZED_WASM    = $(ZED_DIR)/target/wasm32-wasip1/$(PROFILE)/forge_zed.wasm
VSIX        = forge.vsix

# ── Default target ───────────────────────────────────────────────

build: build-rust build-dotnet build-vsix build-zed
	@echo ""
	@echo "==> Build complete."
	@echo "    Server:     $(BINARY)"
	@echo "    Sidecar C#: $(SIDECAR_CS_OUT)"
	@echo "    Sidecar F#: $(SIDECAR_FS_OUT)"
	@echo "    VSIX:       $(VSIX)"
	@echo "    Zed:        $(ZED_WASM)"

# ── Rust LSP server (native) ────────────────────────────────────

build-rust:
	@echo "==> Building forge-lsp ($(PROFILE))..."
	cargo build $(CARGO_FLAG)
	@test -f $(BINARY) || { echo "ERROR: $(BINARY) not found" >&2; exit 1; }
	@echo "==> Binary: $(BINARY)"

# ── .NET sidecars (self-contained single-file) ──────────────────

build-dotnet:
	@echo "==> Building C# sidecar ($(DOTNET_CFG), self-contained)..."
	dotnet publish $(SIDECAR_CS)/Forge.Sidecar.CSharp.csproj \
		--configuration $(DOTNET_CFG) \
		--output $(SIDECAR_CS_OUT)
	@echo "==> Building F# sidecar ($(DOTNET_CFG), self-contained)..."
	dotnet publish $(SIDECAR_FS)/Forge.Sidecar.FSharp.fsproj \
		--configuration $(DOTNET_CFG) \
		--output $(SIDECAR_FS_OUT)

# ── VS Code extension (.vsix) ───────────────────────────────────
#
# The .vsix is a thin client. It does NOT bundle the forge-lsp binary or
# the .NET sidecars: bundling the published sidecars (~234 MB unpacked)
# previously broke VS Code's extension scanner and prevented activation
# entirely. The extension resolves forge-lsp via the workflow in
# editors/vscode/src/install.ts:
#   1. user-configured forge.server.path
#   2. ~/.local/bin/forge-lsp (from `make install`)
#   3. anything on $PATH
#   4. download from GitHub releases (last resort, time-bounded)
#
# Run `make install` once to populate ~/.local/bin and ~/.local/lib/forge.

build-vsix:
	@echo "==> Cleaning stale bundled binaries from $(VSCODE_DIR)/bin/..."
	@rm -rf $(VSCODE_DIR)/bin
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

# ── CI (full pipeline: build → lint → test) ────────────────────

ci: build lint test
	@echo ""
	@echo "==> CI pipeline passed."

# ── Tests (with coverage + threshold enforcement) ──────────────

CHECK_COV = scripts/check-coverage.sh

test: build test-rust test-zed test-vsix test-dotnet
	@echo ""
	@echo "==> All tests passed. All coverage thresholds met."

test-rust: build-dotnet
	@echo "==> Running forge-lsp tests with coverage..."
	cargo llvm-cov --json --output-path target/coverage-rust.json
	@$(CHECK_COV) forge-lsp "$$(jq '.data[0].totals.lines.percent' target/coverage-rust.json)"

test-zed: build-zed
	@echo "==> Running Zed extension tests..."
	cargo test --manifest-path $(ZED_DIR)/Cargo.toml

test-vsix: build-vsix
	@echo "==> Running VS Code extension tests with coverage..."
	cd $(VSCODE_DIR) && npm test -- --coverage
	@$(CHECK_COV) vscode-extension "$$(jq '.total.lines.pct' $(VSCODE_DIR)/coverage/coverage-summary.json)"

test-dotnet: build-dotnet
	@echo "==> Running .NET sidecar tests with coverage..."
	@rm -rf target/coverage-dotnet
	@dotnet test $(SIDECAR_SLN) --configuration $(DOTNET_CFG) \
		--collect:"XPlat Code Coverage" \
		--results-directory target/coverage-dotnet \
		-- RunConfiguration.FailFastEnabled=true DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=cobertura ; \
	 TEST_EXIT=$$? ; \
	 CSHARP_COV=$$(for f in target/coverage-dotnet/*/coverage.cobertura.xml; do \
		sed -n 's/.*package name="Forge.Sidecar.CSharp" line-rate="\([^"]*\)".*/\1/p' "$$f" 2>/dev/null | head -1; \
	 done | head -1) ; \
	 CSHARP_PCT=$$(echo "$${CSHARP_COV:-0} * 100" | bc 2>/dev/null || echo "0") ; \
	 $(CHECK_COV) forge-sidecar-csharp "$$CSHARP_PCT" ; \
	 FSHARP_COV=$$(for f in target/coverage-dotnet/*/coverage.cobertura.xml; do \
		sed -n 's/.*package name="Forge.Sidecar.FSharp" line-rate="\([^"]*\)".*/\1/p' "$$f" 2>/dev/null | head -1; \
	 done | head -1) ; \
	 FSHARP_PCT=$$(echo "$${FSHARP_COV:-0} * 100" | bc 2>/dev/null || echo "0") ; \
	 $(CHECK_COV) forge-sidecar-fsharp "$$FSHARP_PCT" ; \
	 COMMON_COV=$$(for f in target/coverage-dotnet/*/coverage.cobertura.xml; do \
		sed -n 's/.*package name="Forge.Sidecar.Common" line-rate="\([^"]*\)".*/\1/p' "$$f" 2>/dev/null; \
	 done | sort -rn | head -1) ; \
	 COMMON_PCT=$$(echo "$${COMMON_COV:-0} * 100" | bc 2>/dev/null || echo "0") ; \
	 $(CHECK_COV) forge-sidecar-common "$$COMMON_PCT" ; \
	 exit $$TEST_EXIT

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
		-warnaserror \
		/p:UseSharedCompilation=false \
		/nodeReuse:false \
		-maxcpucount:1

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

# ── Install (system-wide: /usr/local/bin + /usr/local/lib/forge/) ──

PREFIX     ?= $(HOME)/.local
LIBDIR      = $(PREFIX)/lib/forge

install: build-rust build-dotnet
	@mkdir -p $(PREFIX)/bin
	cp $(BINARY) $(PREFIX)/bin/forge-lsp
	chmod +x $(PREFIX)/bin/forge-lsp
	rm -rf $(LIBDIR)/sidecar-csharp $(LIBDIR)/sidecar-fsharp
	mkdir -p $(LIBDIR)/sidecar-csharp $(LIBDIR)/sidecar-fsharp
	cp -r $(SIDECAR_CS_OUT)/* $(LIBDIR)/sidecar-csharp/
	cp -r $(SIDECAR_FS_OUT)/* $(LIBDIR)/sidecar-fsharp/
	@echo "==> Installed:"
	@echo "    $(PREFIX)/bin/forge-lsp"
	@echo "    $(LIBDIR)/sidecar-csharp/"
	@echo "    $(LIBDIR)/sidecar-fsharp/"
	@echo ""
	@echo "    Make sure $(PREFIX)/bin is on your \$$PATH"

# ── Rebuild VSIX (uninstall → clean node_modules → rebuild → package) ──

rebuild-vsix:
	@echo "==> Uninstalling old VSIX from VS Code..."
	-code --uninstall-extension forge-lsp.forge 2>/dev/null
	@echo "==> Cleaning VS Code extension node_modules + dist + vsix..."
	rm -rf $(VSCODE_DIR)/node_modules $(VSCODE_DIR)/dist $(VSCODE_DIR)/out
	rm -f $(VSIX)
	$(MAKE) build-vsix
	@echo "==> VSIX packaged at $(VSIX)."

# ── Fresh VSIX (uninstall → full clean → install LSP → package VSIX) ──
#
# Use this to get a clean, reproducible VSIX package without installing it.
# After this completes, install manually with:
#   code --install-extension $(VSIX)

fresh-vsix:
	@echo "==> Uninstalling old VSIX from VS Code..."
	-code --uninstall-extension forge-lsp.forge 2>/dev/null
	@echo "==> Cleaning all build artifacts..."
	$(MAKE) clean
	rm -rf $(VSCODE_DIR)/node_modules
	@echo "==> Installing LSP binary and sidecars..."
	$(MAKE) install
	@echo "==> Packaging VSIX..."
	$(MAKE) build-vsix
	@echo ""
	@echo "==> Fresh build complete."
	@echo "    VSIX: $(VSIX)"
	@echo "    Install manually with: code --install-extension $(VSIX)"

# ── Clean ────────────────────────────────────────────────────────

clean:
	@echo "==> Cleaning all build artifacts..."
	cargo clean
	cargo clean --manifest-path $(ZED_DIR)/Cargo.toml
	rm -rf $(SIDECAR_CS_OUT) $(SIDECAR_FS_OUT)
	rm -rf $(VSCODE_DIR)/dist $(VSCODE_DIR)/out
	rm -f $(VSIX)
	@echo "==> Clean."
