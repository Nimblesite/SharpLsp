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
#   make package-vsix-linux-x64 VERSION=x.y.z       build + package VSIX for linux-x64
#   make package-vsix-linux-arm64 VERSION=x.y.z     build + package VSIX for linux-arm64
#   make package-vsix-darwin-arm64 VERSION=x.y.z    build + package VSIX for darwin-arm64
#   make package-vsix-darwin-x64 VERSION=x.y.z      build + package VSIX for darwin-x64
#   make package-vsix-win32-x64 VERSION=x.y.z       build + package VSIX for win32-x64
#   make package-vsix-win32-arm64 VERSION=x.y.z     build + package VSIX for win32-arm64
#
#   VERSION is required for all package-vsix-* targets.
#
#   make print-publish-commands              download VSIXs from latest release and print vsce publish commands

# ── OS detection ──────────────────────────────────────────────────
# All recipes assume a POSIX shell. On Windows we use Git Bash (bundled with
# Git for Windows) — NOT WSL's bash, which lives in System32 and would mangle
# Windows paths. Install Git for Windows if no bash is found.
ifeq ($(OS),Windows_NT)
    DETECTED_OS := windows
    EXE_EXT     := .exe
    # Probe well-known Git-for-Windows install locations. DOS 8.3 short names
    # avoid the space in "Program Files" which GNU Make cannot quote in SHELL.
    GIT_BASH_CANDIDATES := \
      C:/PROGRA~1/Git/bin/bash.exe \
      C:/PROGRA~2/Git/bin/bash.exe \
      C:/msys64/usr/bin/bash.exe \
      C:/cygwin64/bin/bash.exe
    SHELL := $(firstword $(wildcard $(GIT_BASH_CANDIDATES)))
    ifeq ($(SHELL),)
      $(error No POSIX bash found. Install Git for Windows from https://git-scm.com/download/win)
    endif
else
    DETECTED_OS := $(shell uname -s | tr '[:upper:]' '[:lower:]')
    EXE_EXT     :=
    SHELL       := /bin/bash
endif
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

BINARY         = target/$(PROFILE)/sharplsp$(EXE_EXT)
SIDECAR_CS_OUT = target/sidecar-csharp
SIDECAR_FS_OUT = target/sidecar-fsharp
ZED_WASM       = $(ZED_DIR)/target/wasm32-wasip1/$(PROFILE)/sharplsp_zed.wasm
ZED_PKG_DIR    = target/zed-extension
ZED_PKG_TAR    = sharplsp-zed-extension.tar.gz
RIDER_ZIP      = sharplsp-rider.zip

# Host platform for local VSIX dev builds
HOST_PLATFORM = $(shell node -e "process.stdout.write(process.platform + '-' + process.arch)")
HOST_VSIX_BIN = $(VSCODE_DIR)/bin/$(HOST_PLATFORM)/sharplsp$(EXE_EXT)

PREFIX   ?= $(HOME)/.local
BINDIR    = $(PREFIX)/bin
CHECK_COV = scripts/check-coverage.sh

.PHONY: build ci test lint fmt clean setup screenshots \
        package-vsix-linux-x64 package-vsix-linux-arm64 \
        package-vsix-darwin-arm64 package-vsix-darwin-x64 \
        package-vsix-win32-x64 package-vsix-win32-arm64 \
        print-publish-commands \
        _stamp-version \
        _build-rust _build-dotnet _build-vsix _build-zed _build-rider \
        _stage-vsix-binary _stage-sidecars \
        test-rust _test-rust _test-vsix _test-dotnet _test-website \
        _lint-rust _lint-zed _lint-vsix _lint-dotnet \
        _fmt-rust _fmt-zed _fmt-vsix _fmt-dotnet \
        _package-vsix \
        _deploy-rust _deploy-sidecars \
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
	@echo "==> Checking for .NET 10 SDK..."
	@dotnet --list-sdks 2>/dev/null | grep -q '^10\.' || { \
		echo "ERROR: .NET 10 SDK is not installed. The sidecars target net10.0 and require the .NET 10 SDK to build." >&2; \
		echo "       Install it from https://dot.net or via: brew install dotnet-sdk" >&2; \
		exit 1; \
	}
	@echo "==> Building sidecars ($(DOTNET_CFG))..."
	dotnet publish $(SIDECAR_CS)/SharpLsp.Sidecar.CSharp.csproj --configuration $(DOTNET_CFG) --no-self-contained -p:DebugType=none -p:DebugSymbols=false $(if $(VERSION),-p:Version=$(VERSION) -p:PackageVersion=$(VERSION),) --output $(SIDECAR_CS_OUT)
	dotnet publish $(SIDECAR_FS)/SharpLsp.Sidecar.FSharp.fsproj --configuration $(DOTNET_CFG) --no-self-contained -p:DebugType=none -p:DebugSymbols=false $(if $(VERSION),-p:Version=$(VERSION) -p:PackageVersion=$(VERSION),) --output $(SIDECAR_FS_OUT)

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
	@zip=$$(ls $(RIDER_DIR)/build/distributions/sharplsp-rider-*.zip 2>/dev/null | head -n1); \
		test -n "$$zip" || { echo "ERROR: no Rider plugin zip in $(RIDER_DIR)/build/distributions/" >&2; exit 1; }; \
		cp "$$zip" $(RIDER_ZIP)

_stage-vsix-binary: _build-rust _build-dotnet
	@echo "==> Staging required VSIX binaries ($(HOST_PLATFORM))..."
	rm -rf $(VSCODE_DIR)/bin
	mkdir -p $(dir $(HOST_VSIX_BIN)) $(VSCODE_DIR)/bin/all
	cp $(BINARY) $(HOST_VSIX_BIN)
	chmod +x $(HOST_VSIX_BIN) 2>/dev/null || true
	cp -r $(SIDECAR_CS_OUT)/. $(VSCODE_DIR)/bin/all/
	cp -r $(SIDECAR_FS_OUT)/. $(VSCODE_DIR)/bin/all/
	@mv $(VSCODE_DIR)/bin/all/SharpLsp.Sidecar.CSharp$(EXE_EXT) \
		$(VSCODE_DIR)/bin/all/sharplsp-sidecar-csharp$(EXE_EXT) 2>/dev/null || true
	@mv $(VSCODE_DIR)/bin/all/SharpLsp.Sidecar.FSharp$(EXE_EXT) \
		$(VSCODE_DIR)/bin/all/sharplsp-sidecar-fsharp$(EXE_EXT) 2>/dev/null || true
	chmod +x $(VSCODE_DIR)/bin/all/sharplsp-sidecar-csharp$(EXE_EXT) \
		$(VSCODE_DIR)/bin/all/sharplsp-sidecar-fsharp$(EXE_EXT) 2>/dev/null || true

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
	# --no-fail-fast is intentional ([TEST-RULES] documented exception): coverage
	# enforcement requires every test to run so the measured line percentage is
	# complete; stopping at the first failure would under-report coverage and make
	# the threshold gate meaningless. A real test failure still fails the build via
	# nextest's non-zero exit, which then fails `make test`.
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
				-u SHARPLSP_CSHARP_SIDECAR_PATH \
				-u SHARPLSP_FSHARP_SIDECAR_PATH \
				-u FORGE_LSP_PATH \
				-u FORGE_BINARY_DIR \
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

# ── Version stamping ─────────────────────────────────────────────
# Rewrites the version field in all manifest files before any build.
# VERSION is required — fails immediately if not set.

_stamp-version:
ifndef VERSION
	$(error VERSION is required — e.g. make package-vsix-darwin-arm64 VERSION=0.3.0)
endif
	@echo "==> Stamping version $(VERSION) into all manifests..."
	sed -i.bak 's/^version = "[^"]*"/version = "$(VERSION)"/' Cargo.toml
	sed -i.bak 's/^version = "[^"]*"/version = "$(VERSION)"/' $(ZED_DIR)/Cargo.toml
	sed -i.bak 's/^version = "[^"]*"/version = "$(VERSION)"/' $(ZED_DIR)/extension.toml
	node -e " \
		const fs = require('fs'); \
		const p = '$(VSCODE_DIR)/package.json'; \
		const j = JSON.parse(fs.readFileSync(p,'utf8')); \
		j.version = '$(VERSION)'; \
		fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n'); \
	"
	node -e " \
		const fs = require('fs'); \
		const p = '$(VSCODE_DIR)/package-lock.json'; \
		const j = JSON.parse(fs.readFileSync(p, 'utf8')); \
		j.version = '$(VERSION)'; \
		if (j.packages && j.packages['']) j.packages[''].version = '$(VERSION)'; \
		fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n'); \
	"
	node -e " \
		const fs = require('fs'); \
		const p = '$(VSCODE_DIR)/shipwright.json'; \
		const j = JSON.parse(fs.readFileSync(p,'utf8')); \
		j.product.version = '$(VERSION)'; \
		fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n'); \
	"
	node -e " \
		const fs = require('fs'); \
		const p = 'shipwright.json'; \
		const j = JSON.parse(fs.readFileSync(p,'utf8')); \
		j.product.version = '$(VERSION)'; \
		fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n'); \
	"
	@find . -name '*.bak' -maxdepth 3 -delete 2>/dev/null || true
	@echo "==> Version $(VERSION) stamped."

# ── Package VSIX (per platform) ───────────────────────────────────
# Builds the Rust binary for the given target triple, stages it, and packages
# a platform-specific VSIX into dist/.
#
# Usage:
#   make package-vsix-darwin-arm64 VERSION=0.3.0
#   make package-vsix-darwin-arm64 RUST_TARGET=aarch64-apple-darwin VERSION=0.3.0
#
# VERSION is required and is stamped into all manifests before building.
# RUST_TARGET defaults to the canonical triple for each platform.

package-vsix-linux-x64:   RUST_TARGET ?= x86_64-unknown-linux-gnu
package-vsix-linux-arm64:  RUST_TARGET ?= aarch64-unknown-linux-gnu
package-vsix-darwin-arm64: RUST_TARGET ?= aarch64-apple-darwin
# package-vsix-darwin-x64:   RUST_TARGET ?= x86_64-apple-darwin
package-vsix-win32-x64:    RUST_TARGET ?= x86_64-pc-windows-msvc
package-vsix-win32-arm64:  RUST_TARGET ?= aarch64-pc-windows-msvc

package-vsix-linux-x64 package-vsix-linux-arm64 \
package-vsix-darwin-arm64 package-vsix-darwin-x64 \
package-vsix-win32-x64 package-vsix-win32-arm64: _stamp-version
	$(eval VSIX_PLAT := $(subst package-vsix-,,$@))
	$(eval EXE       := $(if $(filter win32-%,$(VSIX_PLAT)),.exe,))
	@echo "==> Building sharplsp for $(RUST_TARGET)..."
	cargo build --release --target $(RUST_TARGET)
	$(MAKE) _build-dotnet DOTNET_CFG=Release VERSION=$(VERSION)
	$(MAKE) _package-vsix VSIX_PLAT=$(VSIX_PLAT) RUST_TARGET=$(RUST_TARGET) EXE=$(EXE) VERSION=$(VERSION)

_package-vsix:
	@echo "==> Packaging VSIX for $(VSIX_PLAT)..."
	rm -rf $(VSCODE_DIR)/bin/$(VSIX_PLAT) $(VSCODE_DIR)/bin/all
	mkdir -p $(VSCODE_DIR)/bin/$(VSIX_PLAT) $(VSCODE_DIR)/bin/all
	cp target/$(RUST_TARGET)/release/sharplsp$(EXE) $(VSCODE_DIR)/bin/$(VSIX_PLAT)/sharplsp$(EXE)
	chmod +x $(VSCODE_DIR)/bin/$(VSIX_PLAT)/sharplsp$(EXE) 2>/dev/null || true
	cp -r $(SIDECAR_CS_OUT)/. $(VSCODE_DIR)/bin/all/
	cp -r $(SIDECAR_FS_OUT)/. $(VSCODE_DIR)/bin/all/
	@mv $(VSCODE_DIR)/bin/all/SharpLsp.Sidecar.CSharp$(EXE_EXT) \
		$(VSCODE_DIR)/bin/all/sharplsp-sidecar-csharp$(EXE_EXT) 2>/dev/null || true
	@mv $(VSCODE_DIR)/bin/all/SharpLsp.Sidecar.FSharp$(EXE_EXT) \
		$(VSCODE_DIR)/bin/all/sharplsp-sidecar-fsharp$(EXE_EXT) 2>/dev/null || true
	chmod +x $(VSCODE_DIR)/bin/all/sharplsp-sidecar-csharp$(EXE_EXT) \
		$(VSCODE_DIR)/bin/all/sharplsp-sidecar-fsharp$(EXE_EXT) 2>/dev/null || true
	npm run build --prefix $(VSCODE_DIR)
	mkdir -p dist
	# vsce/ovsx refuse to PUBLISH with --pre-release unless the VSIX was also
	# PACKAGED with --pre-release (it sets preRelease=true in the embedded
	# manifest). A hyphenated SemVer VERSION (e.g. 0.2.0-rc.1) is a prerelease.
	cd $(VSCODE_DIR) && npx @vscode/vsce package --no-dependencies \
		$(if $(findstring -,$(VERSION)),--pre-release,) \
		--target $(VSIX_PLAT) \
		-o ../../dist/sharplsp-$(VSIX_PLAT).vsix
	rm -rf $(VSCODE_DIR)/bin
	@echo "==> dist/sharplsp-$(VSIX_PLAT).vsix ready."

# ── Marketplace publish helpers ──────────────────────────────────
# Downloads all VSIX assets from the latest GitHub release and prints the
# vsce publish command for each one. Does NOT publish anything.
#
# Usage:
#   make print-publish-commands

print-publish-commands:
	@echo "==> Fetching VSIX assets from latest release..."
	@mkdir -p dist/publish-latest
	@gh release download --pattern "*.vsix" --dir dist/publish-latest --clobber
	@echo ""
	@echo "==> Run these commands to publish to the VS Code Marketplace:"
	@echo ""
	@for vsix in dist/publish-latest/*.vsix; do \
		echo "npx @vscode/vsce publish --packagePath $$vsix"; \
	done
	@echo ""

# ── Deploy (private) ─────────────────────────────────────────────

_deploy-rust:
	@echo "==> Installing sharplsp to $(BINDIR)/..."
	mkdir -p $(BINDIR)
	cp $(BINARY) $(BINDIR)/sharplsp
	chmod +x $(BINDIR)/sharplsp

_deploy-sidecars:
	@echo "==> Installing sidecars to $(BINDIR)/..."
	mkdir -p $(BINDIR)
	cp -r $(SIDECAR_CS_OUT)/. $(BINDIR)/
	cp -r $(SIDECAR_FS_OUT)/. $(BINDIR)/
	@mv $(BINDIR)/SharpLsp.Sidecar.CSharp \
		$(BINDIR)/sharplsp-sidecar-csharp 2>/dev/null || true
	@mv $(BINDIR)/SharpLsp.Sidecar.FSharp \
		$(BINDIR)/sharplsp-sidecar-fsharp 2>/dev/null || true
	chmod +x $(BINDIR)/sharplsp-sidecar-csharp \
		$(BINDIR)/sharplsp-sidecar-fsharp 2>/dev/null || true

# ── Install (private) ─────────────────────────────────────────────

_uninstall-vsix:
	@echo "==> Uninstalling existing SharpLsp extension..."
	-code --uninstall-extension sharplsp.sharp-lsp 2>/dev/null || true

_install-binaries: _kill _build-rust _build-dotnet _deploy-rust _deploy-sidecars
	@echo "==> All binaries installed:"
	@echo "    $(BINDIR)/sharplsp"
	@echo "    $(BINDIR)/sharplsp-sidecar-csharp"
	@echo "    $(BINDIR)/sharplsp-sidecar-fsharp"

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

# ── .NET 10 SDK + Runtime install/uninstall ───────────────────────

DOTNET_INSTALL_SCRIPT = $(HOME)/.dotnet-install/dotnet-install.sh

install-dotnet-10:
	@echo "==> Installing .NET 10 SDK + runtime via dotnet-install.sh..."
	@mkdir -p $(HOME)/.dotnet-install
	@if [ ! -f $(DOTNET_INSTALL_SCRIPT) ]; then \
		echo "==> Downloading dotnet-install.sh..."; \
		curl -sSL https://dot.net/v1/dotnet-install.sh -o $(DOTNET_INSTALL_SCRIPT); \
		chmod +x $(DOTNET_INSTALL_SCRIPT); \
	else \
		echo "==> dotnet-install.sh already cached at $(DOTNET_INSTALL_SCRIPT)"; \
	fi
	sudo bash $(DOTNET_INSTALL_SCRIPT) --channel 10.0 --install-dir /usr/local/share/dotnet
	@echo "==> .NET 10 installed:"
	@dotnet --list-sdks | grep '^10\.' || true
	@dotnet --list-runtimes | grep '^Microsoft.*10\.' || true

uninstall-dotnet-10:
	@echo "==> Uninstalling .NET 10 SDK + runtime from /usr/local/share/dotnet..."
	@for sdk in $$(dotnet --list-sdks 2>/dev/null | awk '/^10\./ {print $$1}'); do \
		echo "  Removing SDK $$sdk..."; \
		sudo rm -rf "/usr/local/share/dotnet/sdk/$$sdk"; \
	done
	@for rt in $$(dotnet --list-runtimes 2>/dev/null | awk '/10\./ {print $$2}'); do \
		echo "  Removing runtime $$rt..."; \
		sudo rm -rf "/usr/local/share/dotnet/shared/Microsoft.NETCore.App/$$rt"; \
		sudo rm -rf "/usr/local/share/dotnet/shared/Microsoft.AspNetCore.App/$$rt"; \
		sudo rm -rf "/usr/local/share/dotnet/host/fxr/$$rt"; \
	done
	@echo "==> .NET 10 removed. Remaining:"
	@dotnet --list-sdks || true
	@dotnet --list-runtimes || true
