# agent-pmo:3140e31
# Forge build system
#
# Usage:
#   make                     build everything (release)
#   make PROFILE=debug       build everything (debug)
#   make ci                  lint → test → build — the full pipeline
#   make build-rust          forge-lsp binary only
#   make build-dotnet        C# sidecar only
#   make package-vsix        VS Code extension (no binaries — thin client only)
#   make build-zed           Zed extension WASM only
#   make package-zed         Assemble a distributable Zed extension directory + tarball
#   make package-rider       Build + package the Rider plugin zip
#   make install-binaries    Kill forge, hard-delete, deploy forge-lsp + sidecars to ~/.local
#   make test                run all tests (with coverage + threshold enforcement)
#   make test-rust           test forge-lsp + coverage threshold
#   make test-vsix           test VS Code extension + coverage threshold
#   make lint                lint ALL languages (Rust, TypeScript, .NET)
#   make fmt                 format ALL languages (Rust, TypeScript, .NET)
#   make clean               remove build artifacts
#   make setup               post-create dev environment setup

# ── Cross-platform support ──────────────────────────────────────
ifeq ($(OS),Windows_NT)
  SHELL := powershell.exe
  .SHELLFLAGS := -NoProfile -Command
  RM = Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  MKDIR = New-Item -ItemType Directory -Force
  HOME ?= $(USERPROFILE)
else
  RM = rm -rf
  MKDIR = mkdir -p
endif

# Fail fast: any error in any command or pipeline = immediate abort.
SHELL := /bin/bash
.SHELLFLAGS := -eo pipefail -c

.PHONY: ci build build-rust build-dotnet build-zed package-zed \
       package-vsix package-rider clean-rider \
       test test-rust test-zed test-vsix test-dotnet \
       lint lint-rust lint-zed lint-vsix lint-dotnet \
       fmt fmt-rust fmt-zed fmt-vsix fmt-dotnet \
       kill-forge install-binaries \
       setup clean

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
ZED_PKG_DIR = target/zed-extension
ZED_PKG_TAR = forge-zed-extension.tar.gz
RIDER_DIR   = editors/rider
RIDER_ZIP_SRC = $(RIDER_DIR)/build/distributions/forge-rider-0.1.0.zip
RIDER_ZIP   = forge-rider.zip

# ── Install paths ────────────────────────────────────────────────

PREFIX  ?= $(HOME)/.local
LIBDIR   = $(PREFIX)/lib/forge

# ── Coverage ─────────────────────────────────────────────────────

CHECK_COV = scripts/check-coverage.sh

# ── Default target ───────────────────────────────────────────────

build: build-rust build-dotnet package-vsix build-zed package-rider
	@echo ""
	@echo "==> Build complete."
	@echo "    Server:     $(BINARY)"
	@echo "    Sidecar C#: $(SIDECAR_CS_OUT)"
	@echo "    Sidecar F#: $(SIDECAR_FS_OUT)"
	@echo "    VSIX:       $(VSIX)"
	@echo "    Zed:        $(ZED_WASM)"
	@if [ -f $(RIDER_ZIP) ]; then echo "    Rider:      $(RIDER_ZIP)"; fi

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

package-vsix:
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

# ── Zed extension package (dev-install ready) ───────────────────

package-zed: build-zed
	@echo "==> Staging Zed extension source tree at $(ZED_PKG_DIR)..."
	@$(RM) $(ZED_PKG_DIR)
	@$(MKDIR) $(ZED_PKG_DIR)
	cp $(ZED_DIR)/extension.toml $(ZED_PKG_DIR)/extension.toml
	cp $(ZED_DIR)/Cargo.toml    $(ZED_PKG_DIR)/Cargo.toml
	cp $(ZED_DIR)/Cargo.lock    $(ZED_PKG_DIR)/Cargo.lock
	cp -R $(ZED_DIR)/src        $(ZED_PKG_DIR)/src
	@test -f $(ZED_PKG_DIR)/extension.toml || { echo "ERROR: extension.toml missing" >&2; exit 1; }
	@test -f $(ZED_PKG_DIR)/Cargo.toml || { echo "ERROR: Cargo.toml missing" >&2; exit 1; }
	@test -d $(ZED_PKG_DIR)/src || { echo "ERROR: src/ missing" >&2; exit 1; }
	@echo "==> Creating tarball $(ZED_PKG_TAR)..."
	@$(RM) $(ZED_PKG_TAR)
	tar -czf $(ZED_PKG_TAR) -C $(dir $(ZED_PKG_DIR)) $(notdir $(ZED_PKG_DIR))
	@echo ""
	@echo "==> Zed extension packaged."
	@echo "    Source tree: $(ZED_PKG_DIR)/"
	@echo "    Tarball:     $(ZED_PKG_TAR)"

# ── JetBrains Rider plugin ──────────────────────────────────────

package-rider:
	@if ! command -v java >/dev/null 2>&1; then \
		echo "==> Skipping Rider plugin (no 'java' on PATH — install JDK 21 to build)"; \
		exit 0; \
	fi
	@echo "==> Building Forge Rider plugin..."
	cd $(RIDER_DIR) && ./gradlew buildPlugin --no-daemon
	@test -f $(RIDER_ZIP_SRC) || { echo "ERROR: $(RIDER_ZIP_SRC) not found" >&2; exit 1; }
	@echo "==> Copying Rider plugin to repo root as $(RIDER_ZIP)..."
	@$(RM) $(RIDER_ZIP)
	cp $(RIDER_ZIP_SRC) $(RIDER_ZIP)
	@echo "==> Rider plugin packaged: $(RIDER_ZIP)"

clean-rider:
	@echo "==> Cleaning Rider plugin build artifacts..."
	@if [ -d $(RIDER_DIR) ] && command -v java >/dev/null 2>&1; then \
		cd $(RIDER_DIR) && ./gradlew clean --no-daemon || true; \
	fi
	$(RM) $(RIDER_DIR)/build $(RIDER_DIR)/.gradle
	$(RM) $(RIDER_ZIP)
	@echo "==> Rider clean."

# ── CI (full pipeline: lint → test → build) ─────────────────────

ci: lint test build
	@echo ""
	@echo "==> CI pipeline passed."

# ── Tests (with coverage + threshold enforcement) ────────────────

test: build test-rust test-zed test-vsix test-dotnet
	@echo ""
	@echo "==> All tests passed. All coverage thresholds met."

test-rust: build-dotnet
	@echo "==> Staging sidecars for Rust integration tests..."
	@$(MKDIR) target/debug/sidecar-csharp target/debug/sidecar-fsharp
	@$(MKDIR) target/llvm-cov-target/debug/sidecar-csharp target/llvm-cov-target/debug/sidecar-fsharp
	@cp -r $(SIDECAR_CS_OUT)/. target/debug/sidecar-csharp/
	@cp -r $(SIDECAR_FS_OUT)/. target/debug/sidecar-fsharp/
	@cp -r $(SIDECAR_CS_OUT)/. target/llvm-cov-target/debug/sidecar-csharp/
	@cp -r $(SIDECAR_FS_OUT)/. target/llvm-cov-target/debug/sidecar-fsharp/
	@echo "==> Running forge-lsp tests with coverage (nextest, fail-fast)..."
	cargo llvm-cov nextest --json --output-path target/coverage-rust.json --fail-fast
	@$(CHECK_COV) forge-lsp "$$(jq '.data[0].totals.lines.percent' target/coverage-rust.json)"

test-zed: build-zed
	@echo "==> Running Zed extension tests (nextest, fail-fast)..."
	cargo nextest run --manifest-path $(ZED_DIR)/Cargo.toml --fail-fast

test-vsix: build-rust build-dotnet package-vsix
	@echo "==> Staging forge-lsp + sidecars at $(PREFIX) so VS Code tests find them via the install priority chain..."
	@$(MKDIR) $(PREFIX)/bin $(LIBDIR)/sidecar-csharp $(LIBDIR)/sidecar-fsharp
	@cp $(BINARY) $(PREFIX)/bin/forge-lsp
	@chmod +x $(PREFIX)/bin/forge-lsp
	@cp -r $(SIDECAR_CS_OUT)/. $(LIBDIR)/sidecar-csharp/
	@cp -r $(SIDECAR_FS_OUT)/. $(LIBDIR)/sidecar-fsharp/
	@echo "==> Running VS Code extension tests with coverage..."
	cd $(VSCODE_DIR) && npm test -- --coverage
	@$(CHECK_COV) vscode-extension "$$(jq '.total.lines.pct' $(VSCODE_DIR)/coverage/coverage-summary.json)"

test-dotnet: build-dotnet
	@echo "==> Running .NET sidecar tests with coverage..."
	@$(RM) target/coverage-dotnet
	@dotnet test $(SIDECAR_SLN) --configuration $(DOTNET_CFG) \
		--collect:"XPlat Code Coverage" \
		--results-directory target/coverage-dotnet \
		--settings coverlet.runsettings \
		-- RunConfiguration.FailFastEnabled=true ; \
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
	@echo "==> [Rust] Clippy (forge-lsp, all targets including tests)..."
	cargo clippy $(CARGO_FLAG) --all-targets -- -D warnings

lint-zed:
	@echo "==> [Rust] Clippy (Zed extension, all targets including tests)..."
	cargo clippy --manifest-path $(ZED_DIR)/Cargo.toml --all-targets -- -D warnings

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
	cd $(VSCODE_DIR) && npx prettier --write 'src/**/*.ts'

fmt-dotnet:
	@echo "==> [.NET] Formatting sidecars..."
	dotnet csharpier format $(SIDECAR_SLN)/..
	dotnet format $(SIDECAR_SLN)

# ── Setup (devcontainer post-create) ─────────────────────────────

setup:
	@echo "==> Setting up development environment..."
	rustup component add clippy rustfmt llvm-tools-preview
	cargo install cargo-llvm-cov || true
	cd $(VSCODE_DIR) && npm install
	dotnet restore $(SIDECAR_SLN)
	dotnet tool restore
	@echo "==> Setup complete. Run 'make ci' to validate."

# ── Kill forge processes ─────────────────────────────────────────

kill-forge:
	@echo "==> Killing stale forge-lsp and sidecar processes..."
	-@pkill -9 -f 'forge-lsp' 2>/dev/null || true
	-@pkill -9 -f 'Forge\.Sidecar\.' 2>/dev/null || true
	@sleep 0.5
	@echo "==> Processes killed."

# ── Install binaries (kill → hard-delete → deploy) ───────────────

install-binaries: build-rust build-dotnet kill-forge
	@echo "==> Hard-deleting existing binaries from install prefix..."
	$(RM) $(PREFIX)/bin/forge-lsp
	$(RM) $(LIBDIR)/sidecar-csharp $(LIBDIR)/sidecar-fsharp
	@echo "==> Deploying forge-lsp to $(PREFIX)/bin/..."
	$(MKDIR) $(PREFIX)/bin
	cp $(BINARY) $(PREFIX)/bin/forge-lsp
	chmod +x $(PREFIX)/bin/forge-lsp
	@echo "==> Deploying sidecars to $(LIBDIR)/..."
	$(MKDIR) $(LIBDIR)/sidecar-csharp $(LIBDIR)/sidecar-fsharp
	cp -r $(SIDECAR_CS_OUT)/. $(LIBDIR)/sidecar-csharp/
	cp -r $(SIDECAR_FS_OUT)/. $(LIBDIR)/sidecar-fsharp/
	-@xattr -cr $(LIBDIR)/sidecar-csharp/ $(LIBDIR)/sidecar-fsharp/ 2>/dev/null || true
	@echo ""
	@echo "==> Installed:"
	@echo "    $(PREFIX)/bin/forge-lsp"
	@echo "    $(LIBDIR)/sidecar-csharp/"
	@echo "    $(LIBDIR)/sidecar-fsharp/"
	@echo ""
	@echo "    Make sure $(PREFIX)/bin is on your \$$PATH"

# ── Clean ────────────────────────────────────────────────────────

clean: clean-rider
	@echo "==> Cleaning all build artifacts..."
	cargo clean
	cargo clean --manifest-path $(ZED_DIR)/Cargo.toml
	$(RM) $(SIDECAR_CS_OUT) $(SIDECAR_FS_OUT)
	$(RM) $(VSCODE_DIR)/bin $(VSCODE_DIR)/dist $(VSCODE_DIR)/out
	$(RM) $(ZED_PKG_DIR)
	$(RM) $(VSIX) $(ZED_PKG_TAR)
	@echo "==> Clean."
