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
#   make package-zed         Assemble a distributable Zed extension directory + tarball
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

.PHONY: ci build build-rust build-dotnet build-vsix build-zed package-zed \
       build-rider package-rider clean-rider \
       test test-rust test-zed test-vsix test-dotnet \
       lint lint-rust lint-zed lint-vsix lint-dotnet \
       fmt fmt-rust fmt-zed fmt-vsix fmt-dotnet \
       kill-forge install clean rebuild-vsix fresh-vsix

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

# ── Default target ───────────────────────────────────────────────

build: build-rust build-dotnet build-vsix build-zed package-rider
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

# ── Zed extension package (dev-install ready) ───────────────────
#
# IMPORTANT: Zed's "install dev extension" action RECOMPILES the extension
# from source on your machine. It does NOT load a pre-built .wasm. It
# therefore needs the full source tree — `extension.toml`, `Cargo.toml`,
# and `src/`. A bare wasm directory produces
#   "No extension manifest found for extension forge"
#
# What `package-zed` does:
#   1. Runs `build-zed` as a smoke test that the source compiles cleanly
#      on your toolchain (catches broken deps / missing wasm target now,
#      not later when the user tries to dev-install).
#   2. Stages a SELF-CONTAINED source tree at `target/zed-extension/` —
#      this is what you feed to Zed's "install dev extension" dialog.
#      It contains everything Zed needs to recompile: `extension.toml`,
#      `Cargo.toml`, `Cargo.lock`, and `src/`.
#   3. Tars the staged directory into `forge-zed-extension.tar.gz` for
#      distribution (GitHub releases, etc.). End users extract the tar,
#      cd into it, and run "zed: install dev extension" on the resulting
#      directory.
#
# You can also dev-install directly from `editors/zed/` without packaging
# — but that pollutes the source tree with Zed's build artifacts. The
# staged `target/zed-extension/` keeps the dev-install sandboxed.

package-zed: build-zed
	@echo "==> Staging Zed extension source tree at $(ZED_PKG_DIR)..."
	@rm -rf $(ZED_PKG_DIR)
	@mkdir -p $(ZED_PKG_DIR)
	cp $(ZED_DIR)/extension.toml $(ZED_PKG_DIR)/extension.toml
	cp $(ZED_DIR)/Cargo.toml    $(ZED_PKG_DIR)/Cargo.toml
	cp $(ZED_DIR)/Cargo.lock    $(ZED_PKG_DIR)/Cargo.lock
	cp -R $(ZED_DIR)/src        $(ZED_PKG_DIR)/src
	@test -f $(ZED_PKG_DIR)/extension.toml || { echo "ERROR: extension.toml missing" >&2; exit 1; }
	@test -f $(ZED_PKG_DIR)/Cargo.toml || { echo "ERROR: Cargo.toml missing" >&2; exit 1; }
	@test -d $(ZED_PKG_DIR)/src || { echo "ERROR: src/ missing" >&2; exit 1; }
	@echo "==> Creating tarball $(ZED_PKG_TAR)..."
	@rm -f $(ZED_PKG_TAR)
	tar -czf $(ZED_PKG_TAR) -C $(dir $(ZED_PKG_DIR)) $(notdir $(ZED_PKG_DIR))
	@echo ""
	@echo "==> Zed extension packaged."
	@echo "    Source tree: $(ZED_PKG_DIR)/"
	@echo "    Tarball:     $(ZED_PKG_TAR)"
	@echo ""
	@echo "    Dev-install into Zed (recompiles on your machine):"
	@echo "      1. Open the command palette (cmd-shift-p / ctrl-shift-p)"
	@echo "      2. Run: zed: install dev extension"
	@echo "      3. Select $(abspath $(ZED_PKG_DIR))"
	@echo ""
	@echo "    Prerequisites:"
	@echo "      - Rust installed via rustup (Zed invokes cargo to build)"
	@echo "      - wasm32-wasip1 target: rustup target add wasm32-wasip1"
	@echo "      - forge-lsp on \$$PATH: run 'make install' once."

# ── JetBrains Rider plugin ──────────────────────────────────────
#
# The Rider plugin lives in `editors/rider/` and is built with the
# `org.jetbrains.intellij.platform` Gradle plugin. It requires:
#   - JDK 21 (brew install openjdk@21 on macOS)
#   - Gradle 9.0+ (wrapper handles this automatically)
#   - ~2 GB free disk for the cached Rider platform extraction
#
# `build-rider` produces `editors/rider/build/distributions/forge-rider-0.1.0.zip`
# and `package-rider` copies it to `forge-rider.zip` at the repo root
# so the top-level `make build` has one canonical output alongside `forge.vsix`.
#
# Gracefully skips on machines without a JVM — CI can run `make build`
# without exploding on agents that only have Rust + .NET.

build-rider:
	@if ! command -v java >/dev/null 2>&1; then \
		echo "==> Skipping Rider plugin (no 'java' on PATH — install JDK 21 to build)"; \
		exit 0; \
	fi
	@echo "==> Building Forge Rider plugin..."
	cd $(RIDER_DIR) && ./gradlew buildPlugin --no-daemon
	@test -f $(RIDER_ZIP_SRC) || { echo "ERROR: $(RIDER_ZIP_SRC) not found" >&2; exit 1; }
	@echo "==> Rider plugin zip: $(RIDER_ZIP_SRC)"

package-rider: build-rider
	@if [ ! -f $(RIDER_ZIP_SRC) ]; then \
		echo "==> Skipping package-rider (build-rider produced no output)"; \
		exit 0; \
	fi
	@echo "==> Copying Rider plugin to repo root as $(RIDER_ZIP)..."
	@rm -f $(RIDER_ZIP)
	cp $(RIDER_ZIP_SRC) $(RIDER_ZIP)
	@echo ""
	@echo "==> Rider plugin packaged."
	@echo "    Zip: $(abspath $(RIDER_ZIP))"
	@echo ""
	@echo "    Install into Rider:"
	@echo "      1. Open Rider → Settings → Plugins"
	@echo "      2. Gear icon → Install Plugin from Disk…"
	@echo "      3. Select $(abspath $(RIDER_ZIP))"
	@echo "      4. Restart Rider"
	@echo ""
	@echo "    Prerequisites:"
	@echo "      - forge-lsp on \$$PATH: run 'make install' once."

clean-rider:
	@echo "==> Cleaning Rider plugin build artifacts..."
	@if [ -d $(RIDER_DIR) ] && command -v java >/dev/null 2>&1; then \
		cd $(RIDER_DIR) && ./gradlew clean --no-daemon || true; \
	fi
	rm -rf $(RIDER_DIR)/build $(RIDER_DIR)/.gradle
	rm -f $(RIDER_ZIP)
	@echo "==> Rider clean."

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
	@echo "==> Running forge-lsp tests with coverage (nextest, fail-fast)..."
	cargo llvm-cov nextest --json --output-path target/coverage-rust.json --fail-fast
	@$(CHECK_COV) forge-lsp "$$(jq '.data[0].totals.lines.percent' target/coverage-rust.json)"

test-zed: build-zed
	@echo "==> Running Zed extension tests (nextest, fail-fast)..."
	cargo nextest run --manifest-path $(ZED_DIR)/Cargo.toml --fail-fast

test-vsix: build-rust build-dotnet build-vsix
	@echo "==> Staging forge-lsp + sidecars at $(PREFIX) so VS Code tests find them via the install priority chain..."
	@mkdir -p $(PREFIX)/bin $(LIBDIR)/sidecar-csharp $(LIBDIR)/sidecar-fsharp
	@cp $(BINARY) $(PREFIX)/bin/forge-lsp
	@chmod +x $(PREFIX)/bin/forge-lsp
	@cp -r $(SIDECAR_CS_OUT)/. $(LIBDIR)/sidecar-csharp/
	@cp -r $(SIDECAR_FS_OUT)/. $(LIBDIR)/sidecar-fsharp/
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
	@echo "==> [Rust] Clippy (forge-lsp, all targets including tests)..."
	cargo clippy $(CARGO_FLAG) --all-targets -- -D warnings
	@echo "==> [Rust] Rustfmt check (forge-lsp)..."
	cargo fmt --check

lint-zed:
	@echo "==> [Rust] Clippy (Zed extension, all targets including tests)..."
	cargo clippy --manifest-path $(ZED_DIR)/Cargo.toml --all-targets -- -D warnings
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

# ── Kill stale forge processes ───────────────────────────────────
#
# Zombie forge-lsp processes (especially --version checks spawned by the
# VSCode extension) MUST be killed before installing new binaries.
# Without this, the old binary holds file locks and the extension host
# keeps spawning --version probes that hang forever.

kill-forge:
	@echo "==> Killing stale forge-lsp and sidecar processes..."
	-@pkill -9 -f 'forge-lsp' 2>/dev/null || true
	-@pkill -9 -f 'Forge\.Sidecar\.' 2>/dev/null || true
	@sleep 0.5
	@echo "==> Done."

# ── Install (system-wide: /usr/local/bin + /usr/local/lib/forge/) ──

PREFIX     ?= $(HOME)/.local
LIBDIR      = $(PREFIX)/lib/forge

install: build-rust build-dotnet kill-forge
	@mkdir -p $(PREFIX)/bin
	rm -f $(PREFIX)/bin/forge-lsp
	cp $(BINARY) $(PREFIX)/bin/forge-lsp
	chmod +x $(PREFIX)/bin/forge-lsp
	rm -rf $(LIBDIR)/sidecar-csharp $(LIBDIR)/sidecar-fsharp
	mkdir -p $(LIBDIR)/sidecar-csharp $(LIBDIR)/sidecar-fsharp
	cp -r $(SIDECAR_CS_OUT)/* $(LIBDIR)/sidecar-csharp/
	cp -r $(SIDECAR_FS_OUT)/* $(LIBDIR)/sidecar-fsharp/
	-@xattr -cr $(LIBDIR)/sidecar-csharp/ $(LIBDIR)/sidecar-fsharp/ 2>/dev/null || true
	@echo "==> Installed:"
	@echo "    $(PREFIX)/bin/forge-lsp"
	@echo "    $(LIBDIR)/sidecar-csharp/"
	@echo "    $(LIBDIR)/sidecar-fsharp/"
	@echo ""
	@echo "    Make sure $(PREFIX)/bin is on your \$$PATH"

# ── Rebuild VSIX (uninstall → clean node_modules → rebuild → package) ──

rebuild-vsix: kill-forge
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

fresh-vsix: kill-forge
	@echo "==> Uninstalling old VSIX from VS Code..."
	-code --uninstall-extension forge-lsp.forge 2>/dev/null
	@echo "==> Cleaning all build artifacts..."
	$(MAKE) clean
	rm -rf $(VSCODE_DIR)/node_modules
	@echo "==> Installing LSP binary and sidecars..."
	$(MAKE) install
	@echo "==> Verifying installed binary..."
	@perl -e 'alarm 5; exec @ARGV' $(PREFIX)/bin/forge-lsp --version || { echo "ERROR: forge-lsp --version failed or timed out" >&2; exit 1; }
	@echo "==> Packaging VSIX..."
	$(MAKE) build-vsix
	@echo ""
	@echo "==> Fresh build complete."
	@echo "    VSIX:    $(VSIX)"
	@echo "    Install: code --install-extension $(VSIX)"

# ── Clean ────────────────────────────────────────────────────────

clean: clean-rider
	@echo "==> Cleaning all build artifacts..."
	cargo clean
	cargo clean --manifest-path $(ZED_DIR)/Cargo.toml
	rm -rf $(SIDECAR_CS_OUT) $(SIDECAR_FS_OUT)
	rm -rf $(VSCODE_DIR)/dist $(VSCODE_DIR)/out
	rm -rf $(ZED_PKG_DIR)
	rm -f $(VSIX) $(ZED_PKG_TAR)
	@echo "==> Clean."
