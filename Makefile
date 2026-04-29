# SharpLsp build system
#
# Public targets:
#   make                              build everything (host platform, release)
#   make PROFILE=debug                build everything (debug)
#   make ci                           lint → test → build
#   make test                         run all tests with coverage
#   make lint                         lint all languages
#   make fmt                          format all languages
#   make clean                        remove build artifacts
#   make setup                        install toolchain dependencies
#   make screenshots                  capture website screenshots from real VS Code
#   make package-vsix-linux-x64       build + package VSIX for linux-x64
#   make package-vsix-linux-arm64     build + package VSIX for linux-arm64
#   make package-vsix-darwin-arm64    build + package VSIX for darwin-arm64
#   make package-vsix-darwin-x64      build + package VSIX for darwin-x64
#   make package-vsix-win32-x64       build + package VSIX for win32-x64
#   make package-vsix-win32-arm64     build + package VSIX for win32-arm64

SHELL       := /bin/bash
.SHELLFLAGS := -eo pipefail -c

PROFILE           ?= release
CARGO_FLAG         = $(if $(filter release,$(PROFILE)),--release,)
DOTNET_CFG         = $(if $(filter release,$(PROFILE)),Release,Debug)
RUST_TEST_THREADS ?= 1

VSCODE_DIR  = editors/vscode
ZED_DIR     = editors/zed
SIDECAR_CS  = sidecars/SharpLsp.Sidecar.CSharp
SIDECAR_FS  = sidecars/SharpLsp.Sidecar.FSharp
SIDECAR_SLN = sidecars/SharpLsp.Sidecars.sln
RIDER_DIR   = editors/rider

BINARY         = target/$(PROFILE)/sharplsp
SIDECAR_CS_OUT = target/sidecar-csharp
SIDECAR_FS_OUT = target/sidecar-fsharp
ZED_WASM       = $(ZED_DIR)/target/wasm32-wasip1/$(PROFILE)/sharplsp_zed.wasm
ZED_PKG_DIR    = target/zed-extension
ZED_PKG_TAR    = sharplsp-zed-extension.tar.gz
RIDER_ZIP_SRC  = $(RIDER_DIR)/build/distributions/sharplsp-rider-0.1.0.zip
RIDER_ZIP      = sharplsp-rider.zip

# Host platform for local VSIX dev builds
HOST_PLATFORM = $(shell node -e "process.stdout.write(process.platform + '-' + process.arch)")
HOST_VSIX_BIN = $(VSCODE_DIR)/bin/$(HOST_PLATFORM)/sharplsp

PREFIX   ?= $(HOME)/.local
BINDIR    = $(PREFIX)/bin
CHECK_COV = scripts/check-coverage.sh

.PHONY: build ci test lint fmt clean setup screenshots \
        package-vsix-linux-x64 package-vsix-linux-arm64 \
        package-vsix-darwin-arm64 package-vsix-darwin-x64 \
        package-vsix-win32-x64 package-vsix-win32-arm64 \
        _build-rust _build-dotnet _build-vsix _build-zed _build-rider \
        _stage-vsix-binary _stage-sidecars \
        test-rust _test-rust _test-vsix _test-dotnet _test-website \
        _lint-rust _lint-zed _lint-vsix _lint-dotnet \
        _fmt-rust _fmt-zed _fmt-vsix _fmt-dotnet \
        _package-vsix \
        _deploy-rust _deploy-sidecars _pack-sidecars \
        _install-vsix _uninstall-vsix _install-binaries _install-rust _install-sidecars \
        _kill _clean-rider

# ── Build ─────────────────────────────────────────────────────────

build: _build-rust _build-dotnet _build-vsix _build-zed _build-rider
	@echo ""
	@echo "==> Build complete."
	@echo "    Server:     $(BINARY)"
	@echo "    Sidecar C#: $(SIDECAR_CS_OUT)"
	@echo "    Sidecar F#: $(SIDECAR_FS_OUT)"
	@echo "    Zed:        $(ZED_WASM)"
	@[ -f $(RIDER_ZIP) ] && echo "    Rider:      $(RIDER_ZIP)" || true

_build-rust:
	@echo "==> Building sharplsp ($(PROFILE))..."
	cargo build $(CARGO_FLAG)
	@test -f $(BINARY) || { echo "ERROR: $(BINARY) not found" >&2; exit 1; }

_build-dotnet:
	@echo "==> Building sidecars ($(DOTNET_CFG))..."
	dotnet publish $(SIDECAR_CS)/SharpLsp.Sidecar.CSharp.csproj --configuration $(DOTNET_CFG) --output $(SIDECAR_CS_OUT)
	dotnet publish $(SIDECAR_FS)/SharpLsp.Sidecar.FSharp.fsproj --configuration $(DOTNET_CFG) --output $(SIDECAR_FS_OUT)

_build-vsix: _stage-vsix-binary
	@echo "==> Packaging VS Code extension (host: $(HOST_PLATFORM))..."
	npm run build --prefix $(VSCODE_DIR)
	cd $(VSCODE_DIR) && npx @vscode/vsce package --no-dependencies -o ../../sharplsp.vsix
	rm -rf $(VSCODE_DIR)/bin

_build-zed:
	@echo "==> Building Zed extension..."
	@rustup target list --installed | grep -q wasm32-wasip1 || rustup target add wasm32-wasip1
	cargo build $(CARGO_FLAG) --manifest-path $(ZED_DIR)/Cargo.toml --target wasm32-wasip1
	@test -f $(ZED_WASM) || { echo "ERROR: $(ZED_WASM) not found" >&2; exit 1; }
	@rm -rf $(ZED_PKG_DIR) && mkdir -p $(ZED_PKG_DIR)
	cp $(ZED_DIR)/extension.toml $(ZED_DIR)/Cargo.toml $(ZED_DIR)/Cargo.lock $(ZED_PKG_DIR)/
	cp -R $(ZED_DIR)/src $(ZED_PKG_DIR)/src
	rm -f $(ZED_PKG_TAR) && tar -czf $(ZED_PKG_TAR) -C $(dir $(ZED_PKG_DIR)) $(notdir $(ZED_PKG_DIR))

_build-rider:
	@command -v java >/dev/null 2>&1 || { echo "==> Skipping Rider plugin (no java on PATH)"; exit 0; }
	@echo "==> Building Rider plugin..."
	cd $(RIDER_DIR) && ./gradlew buildPlugin --no-daemon
	@test -f $(RIDER_ZIP_SRC) || { echo "ERROR: $(RIDER_ZIP_SRC) not found" >&2; exit 1; }
	cp $(RIDER_ZIP_SRC) $(RIDER_ZIP)

_stage-vsix-binary: _build-rust
	@echo "==> Staging sharplsp binary for VSIX ($(HOST_PLATFORM))..."
	rm -rf $(VSCODE_DIR)/bin
	mkdir -p $(dir $(HOST_VSIX_BIN))
	cp $(BINARY) $(HOST_VSIX_BIN)
	chmod +x $(HOST_VSIX_BIN)

_stage-sidecars:
	@mkdir -p target/debug/sidecar-csharp target/debug/sidecar-fsharp
	@mkdir -p target/llvm-cov-target/debug/sidecar-csharp target/llvm-cov-target/debug/sidecar-fsharp
	@cp -r $(SIDECAR_CS_OUT)/. target/debug/sidecar-csharp/
	@cp -r $(SIDECAR_FS_OUT)/. target/debug/sidecar-fsharp/
	@cp -r $(SIDECAR_CS_OUT)/. target/llvm-cov-target/debug/sidecar-csharp/
	@cp -r $(SIDECAR_FS_OUT)/. target/llvm-cov-target/debug/sidecar-fsharp/

# ── CI ────────────────────────────────────────────────────────────

ci: lint test build
	@echo "==> CI pipeline passed."

# ── Test ─────────────────────────────────────────────────────────

test: _test-rust _test-vsix _test-dotnet _test-website
	@echo "==> All tests passed."

# Public alias — CI and developers call this.
test-rust: _test-rust

_test-rust: _build-dotnet _stage-sidecars
	@echo "==> Pre-building ProfileTarget fixture..."
	dotnet build tests/fixtures/ProfileTarget/ProfileTarget.csproj -c Release --nologo -v q
	@echo "==> Running sharplsp tests with coverage..."
	SHARPLSP_CSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_CS_OUT))/SharpLsp.Sidecar.CSharp" \
	SHARPLSP_FSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_FS_OUT))/SharpLsp.Sidecar.FSharp" \
		cargo llvm-cov nextest --json --output-path target/coverage-rust.json --no-fail-fast --test-threads $(RUST_TEST_THREADS)
	@$(CHECK_COV) sharplsp "$$(jq '.data[0].totals.lines.percent' target/coverage-rust.json)"

_test-vsix: _build-rust _build-dotnet _build-vsix _stage-vsix-binary
	@echo "==> Running VS Code extension tests..."
	$(MAKE) _stage-vsix-binary
	cd $(VSCODE_DIR) && \
		env -u SHARPLSP_EXECUTABLE_PATH \
			-u SHARPLSP_LSP_PATH \
			-u SHARPLSP_BINARY_DIR \
			-u FORGE_LSP_PATH \
			-u FORGE_BINARY_DIR \
			SHARPLSP_CSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_CS_OUT))/SharpLsp.Sidecar.CSharp" \
			SHARPLSP_FSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_FS_OUT))/SharpLsp.Sidecar.FSharp" \
			npm test -- --coverage; \
	status=$$?; \
	rm -rf "$(abspath $(VSCODE_DIR))/bin"; \
	exit $$status
	@$(CHECK_COV) vscode-extension "$$(jq '.total.lines.pct' $(VSCODE_DIR)/coverage/coverage-summary.json)"

_test-dotnet: _build-dotnet
	@echo "==> Running .NET sidecar tests..."
	@rm -rf target/coverage-dotnet
	dotnet test $(SIDECAR_SLN) --configuration $(DOTNET_CFG) \
		--collect:"XPlat Code Coverage" \
		--results-directory target/coverage-dotnet \
		--settings coverlet.runsettings \
		-- RunConfiguration.FailFastEnabled=true
	@_check_cov() { \
	   local pkg=$$1 label=$$2 ; \
	   pct=$$(for f in target/coverage-dotnet/*/coverage.cobertura.xml; do \
	     sed -n "s/.*package name=\"$$pkg\" line-rate=\"\([^\"]*\)\".*/\1/p" "$$f" 2>/dev/null | head -1; \
	   done | sort -rn | head -1) ; \
	   $(CHECK_COV) "$$label" "$$(echo "$${pct:-0} * 100" | bc 2>/dev/null || echo 0)" ; \
	 } ; \
	 _check_cov SharpLsp.Sidecar.CSharp sharplsp-sidecar-csharp ; \
	 _check_cov SharpLsp.Sidecar.FSharp sharplsp-sidecar-fsharp ; \
	 _check_cov SharpLsp.Sidecar.Common sharplsp-sidecar-common

_test-website:
	@echo "==> Running website Playwright tests..."
	cd website && npm ci && npx playwright install --with-deps chromium && npx playwright test

# ── Lint ─────────────────────────────────────────────────────────

lint: build _lint-rust _lint-zed _lint-vsix _lint-dotnet
	@echo "==> All lints passed."

_lint-rust:
	cargo fmt --check
	cargo clippy $(CARGO_FLAG) --all-targets -- -D warnings

_lint-zed:
	cargo fmt --manifest-path $(ZED_DIR)/Cargo.toml --check
	cargo clippy --manifest-path $(ZED_DIR)/Cargo.toml --all-targets -- -D warnings

_lint-vsix:
	npm run lint:eslint --prefix $(VSCODE_DIR)
	npm run typecheck --prefix $(VSCODE_DIR)

_lint-dotnet:
	dotnet build $(SIDECAR_SLN) --configuration $(DOTNET_CFG) -warnaserror \
		/p:UseSharedCompilation=false /nodeReuse:false -maxcpucount:1

# ── Format ───────────────────────────────────────────────────────

fmt: _fmt-rust _fmt-zed _fmt-vsix _fmt-dotnet
	@echo "==> All formatting complete."

_fmt-rust:
	cargo fmt

_fmt-zed:
	cargo fmt --manifest-path $(ZED_DIR)/Cargo.toml

_fmt-vsix:
	cd $(VSCODE_DIR) && npx prettier --write 'src/**/*.ts'

_fmt-dotnet:
	dotnet csharpier format $(SIDECAR_SLN)/..
	dotnet format $(SIDECAR_SLN)

# ── Screenshots ───────────────────────────────────────────────────

screenshots: _build-rust _build-dotnet _build-vsix _stage-vsix-binary
	@echo "==> Capturing all website screenshots from real VS Code..."
	(cd $(VSCODE_DIR) && node src/test/suite/screenshot-watcher.mjs) & \
	WATCHER_PID=$$!; \
	cd $(VSCODE_DIR) && \
		env -u SHARPLSP_EXECUTABLE_PATH \
			-u SHARPLSP_LSP_PATH \
			-u SHARPLSP_BINARY_DIR \
			SHARPLSP_SCREENSHOTS=1 \
			SHARPLSP_CSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_CS_OUT))/SharpLsp.Sidecar.CSharp" \
			SHARPLSP_FSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_FS_OUT))/SharpLsp.Sidecar.FSharp" \
			npm test -- --coverage; \
	STATUS=$$?; \
	kill $$WATCHER_PID 2>/dev/null || true; \
	rm -rf "$(abspath $(VSCODE_DIR))/bin"; \
	exit $$STATUS

# ── Package VSIX (per platform) ───────────────────────────────────
# Builds the Rust binary for the given target triple, stages it, and packages
# a platform-specific VSIX into dist/.
#
# Usage:
#   make package-vsix-linux-x64
#   make package-vsix-darwin-arm64 RUST_TARGET=aarch64-apple-darwin VERSION=1.2.3
#
# RUST_TARGET defaults to the canonical triple for each platform.
# VERSION is optional; omit it for local dev builds.

package-vsix-linux-x64:   RUST_TARGET ?= x86_64-unknown-linux-gnu
package-vsix-linux-arm64:  RUST_TARGET ?= aarch64-unknown-linux-gnu
package-vsix-darwin-arm64: RUST_TARGET ?= aarch64-apple-darwin
package-vsix-darwin-x64:   RUST_TARGET ?= x86_64-apple-darwin
package-vsix-win32-x64:    RUST_TARGET ?= x86_64-pc-windows-msvc
package-vsix-win32-arm64:  RUST_TARGET ?= aarch64-pc-windows-msvc

package-vsix-linux-x64 package-vsix-linux-arm64 \
package-vsix-darwin-arm64 package-vsix-darwin-x64 \
package-vsix-win32-x64 package-vsix-win32-arm64:
	$(eval VSIX_PLAT := $(subst package-vsix-,,$@))
	$(eval EXE       := $(if $(filter win32-%,$(VSIX_PLAT)),.exe,))
	@echo "==> Building sharplsp for $(RUST_TARGET)..."
	cargo build --release --target $(RUST_TARGET)
	$(MAKE) _package-vsix VSIX_PLAT=$(VSIX_PLAT) RUST_TARGET=$(RUST_TARGET) EXE=$(EXE) VERSION=$(VERSION)

_package-vsix:
	@echo "==> Packaging VSIX for $(VSIX_PLAT)..."
	rm -rf $(VSCODE_DIR)/bin/$(VSIX_PLAT)
	mkdir -p $(VSCODE_DIR)/bin/$(VSIX_PLAT)
	cp target/$(RUST_TARGET)/release/sharplsp$(EXE) $(VSCODE_DIR)/bin/$(VSIX_PLAT)/sharplsp$(EXE)
	chmod +x $(VSCODE_DIR)/bin/$(VSIX_PLAT)/sharplsp$(EXE) 2>/dev/null || true
	mkdir -p $(VSCODE_DIR)/bin/all
	cp $(SIDECAR_CS_OUT)/SharpLsp.Sidecar.CSharp $(VSCODE_DIR)/bin/all/sharplsp-sidecar-csharp
	cp $(SIDECAR_FS_OUT)/SharpLsp.Sidecar.FSharp $(VSCODE_DIR)/bin/all/sharplsp-sidecar-fsharp
	chmod +x $(VSCODE_DIR)/bin/all/sharplsp-sidecar-csharp $(VSCODE_DIR)/bin/all/sharplsp-sidecar-fsharp 2>/dev/null || true
	npm run build --prefix $(VSCODE_DIR)
	mkdir -p dist
	cd $(VSCODE_DIR) && npx @vscode/vsce package --no-dependencies \
		--target $(VSIX_PLAT) \
		$(if $(VERSION),--packageVersion $(VERSION),) \
		-o ../../dist/sharplsp-$(VSIX_PLAT).vsix
	rm -rf $(VSCODE_DIR)/bin
	@echo "==> dist/sharplsp-$(VSIX_PLAT).vsix ready."

# ── Pack sidecars (private) ───────────────────────────────────────
# Produces versioned nupkgs in nupkgs/. Used by the release workflow.
# VERSION must be set: make _pack-sidecars VERSION=1.2.3

_pack-sidecars:
	@test -n "$(VERSION)" || { echo "ERROR: VERSION is required" >&2; exit 1; }
	@echo "==> Packing sidecars at version $(VERSION)..."
	rm -rf nupkgs
	dotnet pack $(SIDECAR_CS)/SharpLsp.Sidecar.CSharp.csproj -p:PackageVersion=$(VERSION) -c Release -o nupkgs
	dotnet pack $(SIDECAR_FS)/SharpLsp.Sidecar.FSharp.fsproj -p:PackageVersion=$(VERSION) -c Release -o nupkgs
	@echo "==> nupkgs/ ready."

# ── Deploy (private) ─────────────────────────────────────────────

_deploy-rust:
	@echo "==> Installing sharplsp to $(BINDIR)/..."
	mkdir -p $(BINDIR)
	cp $(BINARY) $(BINDIR)/sharplsp
	chmod +x $(BINDIR)/sharplsp

_deploy-sidecars:
	@echo "==> Packing + installing sidecar tools..."
	-dotnet tool uninstall -g SharpLsp.Sidecar.CSharp 2>/dev/null || true
	-dotnet tool uninstall -g SharpLsp.Sidecar.FSharp 2>/dev/null || true
	rm -rf target/nupkgs
	dotnet pack $(SIDECAR_CS)/SharpLsp.Sidecar.CSharp.csproj -p:PackageVersion=0.0.0-local -c $(DOTNET_CFG) -o target/nupkgs
	dotnet pack $(SIDECAR_FS)/SharpLsp.Sidecar.FSharp.fsproj -p:PackageVersion=0.0.0-local -c $(DOTNET_CFG) -o target/nupkgs
	dotnet tool install -g SharpLsp.Sidecar.CSharp --version 0.0.0-local --add-source target/nupkgs
	dotnet tool install -g SharpLsp.Sidecar.FSharp --version 0.0.0-local --add-source target/nupkgs

# ── Install (private) ─────────────────────────────────────────────

_install-vsix: _kill clean _build-rust _build-dotnet _build-vsix _uninstall-vsix
	@echo "==> Installing sharplsp.vsix..."
	code --install-extension sharplsp.vsix --force
	@echo "==> VS Code extension installed."

_uninstall-vsix:
	@echo "==> Uninstalling existing SharpLsp extension..."
	-code --uninstall-extension sharplsp.sharp-lsp 2>/dev/null || true

_install-binaries: _kill _build-rust _build-dotnet _deploy-rust _deploy-sidecars
	@echo "==> All binaries installed:"
	@echo "    $(BINDIR)/sharplsp"
	@echo "    sharplsp-sidecar-csharp (dotnet tool)"
	@echo "    sharplsp-sidecar-fsharp (dotnet tool)"

_install-rust: _build-rust _kill _deploy-rust
	@echo "==> Installed: $(BINDIR)/sharplsp"

_install-sidecars: _build-dotnet _kill _deploy-sidecars
	@echo "==> Sidecars installed."

# ── Kill (private) ────────────────────────────────────────────────

_kill:
	@echo "==> Killing stale sharplsp processes..."
	-@pkill -9 -f 'sharplsp' 2>/dev/null || true
	-@pkill -9 -f 'SharpLsp\.Sidecar\.' 2>/dev/null || true
	@sleep 0.5

# ── Clean ─────────────────────────────────────────────────────────

clean: _clean-rider
	@echo "==> Cleaning build artifacts..."
	cargo clean
	cargo clean --manifest-path $(ZED_DIR)/Cargo.toml
	rm -rf $(SIDECAR_CS_OUT) $(SIDECAR_FS_OUT)
	rm -rf $(VSCODE_DIR)/bin $(VSCODE_DIR)/dist $(VSCODE_DIR)/out
	rm -rf $(ZED_PKG_DIR) dist
	rm -f sharplsp.vsix $(ZED_PKG_TAR)
	@echo "==> Clean."

_clean-rider:
	@[ -d $(RIDER_DIR) ] && command -v java >/dev/null 2>&1 && \
		cd $(RIDER_DIR) && ./gradlew clean --no-daemon || true
	rm -rf $(RIDER_DIR)/build $(RIDER_DIR)/.gradle $(RIDER_ZIP)

# ── Setup ─────────────────────────────────────────────────────────

setup:
	@echo "==> Setting up development environment..."
	rustup component add clippy rustfmt llvm-tools-preview
	cargo install cargo-llvm-cov || true
	npm install --prefix $(VSCODE_DIR)
	dotnet restore $(SIDECAR_SLN)
	dotnet tool restore
	@echo "==> Setup complete. Run 'make ci' to validate."
