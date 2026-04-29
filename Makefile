# SharpLsp build system
#
# Public targets:
#   make                     build everything (release)
#   make PROFILE=debug       build everything (debug)
#   make ci                  lint → test → build
#   make install-vsix        clean → build → deploy → install VS Code extension
#   make install-binaries    build + install sharplsp-lsp + sidecars to PATH
#   make install-rust        build + install sharplsp-lsp only
#   make install-sidecars    build + install sidecars only
#   make test                run all tests with coverage
#   make screenshots         capture all website screenshots from real VS Code
#   make screenshot NAME=x   capture one website screenshot from real VS Code
#   make lint                lint all languages
#   make fmt                 format all languages
#   make clean               remove build artifacts

SHELL        := /bin/bash
.SHELLFLAGS  := -eo pipefail -c

PROFILE     ?= release
CARGO_FLAG   = $(if $(filter release,$(PROFILE)),--release,)
DOTNET_CFG   = $(if $(filter release,$(PROFILE)),Release,Debug)

VSCODE_DIR   = editors/vscode
ZED_DIR      = editors/zed
SIDECAR_CS   = sidecars/SharpLsp.Sidecar.CSharp
SIDECAR_FS   = sidecars/SharpLsp.Sidecar.FSharp
SIDECAR_SLN  = sidecars/SharpLsp.Sidecars.sln

BINARY          = target/$(PROFILE)/sharplsp-lsp
SIDECAR_CS_OUT  = target/sidecar-csharp
SIDECAR_FS_OUT  = target/sidecar-fsharp
ZED_WASM        = $(ZED_DIR)/target/wasm32-wasip1/$(PROFILE)/sharplsp_zed.wasm
VSIX            = sharplsp.vsix
ZED_PKG_DIR     = target/zed-extension
ZED_PKG_TAR     = sharplsp-zed-extension.tar.gz
RIDER_DIR       = editors/rider
RIDER_ZIP_SRC   = $(RIDER_DIR)/build/distributions/sharplsp-rider-0.1.0.zip
RIDER_ZIP       = sharplsp-rider.zip

PREFIX  ?= $(HOME)/.local
BINDIR   = $(PREFIX)/bin
LIBDIR   = $(PREFIX)/lib/sharplsp
CHECK_COV = scripts/check-coverage.sh

.PHONY: build ci \
        install-vsix install-binaries install-rust install-sidecars \
        test screenshots screenshot lint fmt clean setup \
        lint-rust lint-zed lint-dotnet lint-vsix \
        test-rust test-zed test-dotnet test-vsix \
        fmt-rust fmt-zed fmt-dotnet fmt-vsix \
        _build-rust _build-dotnet _build-vsix _build-zed _build-rider \
        _kill _clean-rider _stage-sidecars \
        _deploy-rust _deploy-sidecars _uninstall-vsix _install-vsix

# ── Default ───────────────────────────────────────────────────────

build: _build-rust _build-dotnet _build-vsix _build-zed _build-rider
	@echo ""
	@echo "==> Build complete."
	@echo "    Server:     $(BINARY)"
	@echo "    Sidecar C#: $(SIDECAR_CS_OUT)"
	@echo "    Sidecar F#: $(SIDECAR_FS_OUT)"
	@echo "    VSIX:       $(VSIX)"
	@echo "    Zed:        $(ZED_WASM)"
	@[ -f $(RIDER_ZIP) ] && echo "    Rider:      $(RIDER_ZIP)" || true

# ── Public: install VS Code extension end-to-end ─────────────────

install-vsix: _kill clean _build-rust _build-dotnet _build-vsix _uninstall-vsix _install-vsix
	@echo ""
	@echo "==> VS Code extension installed."

# ── Public: install sharplsp-lsp + sidecars ──────────────────────

install-binaries: _kill _build-rust _build-dotnet _deploy-rust _deploy-sidecars
	@echo ""
	@echo "==> All binaries installed:"
	@echo "    $(BINDIR)/sharplsp-lsp"
	@echo "    sharplsp-sidecar-csharp (dotnet tool)"
	@echo "    sharplsp-sidecar-fsharp (dotnet tool)"

install-rust: _build-rust _kill _deploy-rust
	@echo "==> Installed: $(BINDIR)/sharplsp-lsp"

install-sidecars: _build-dotnet _kill _deploy-sidecars
	@echo "==> Sidecars installed."

# ── CI ───────────────────────────────────────────────────────────

ci: lint test build
	@echo "==> CI pipeline passed."

# ── Tests ────────────────────────────────────────────────────────

test: test-rust test-vsix test-dotnet test-website
	@echo "==> All tests passed."

test-rust: _build-dotnet _stage-sidecars
	@echo "==> Pre-building ProfileTarget fixture..."
	dotnet build tests/fixtures/ProfileTarget/ProfileTarget.csproj -c Release --nologo -v q
	@echo "==> Running sharplsp-lsp tests with coverage..."
	cargo llvm-cov nextest --json --output-path target/coverage-rust.json --fail-fast
	@$(CHECK_COV) sharplsp-lsp "$$(jq '.data[0].totals.lines.percent' target/coverage-rust.json)"

test-zed:
	@echo "==> Running Zed tests..."
	cargo nextest run --manifest-path $(ZED_DIR)/Cargo.toml --fail-fast

test-vsix: _build-rust _build-dotnet _build-vsix _deploy-rust
	@echo "==> Running VS Code extension tests..."
	cd $(VSCODE_DIR) && PATH="$(abspath $(BINDIR)):$$PATH" SHARPLSP_EXECUTABLE_PATH="$(abspath $(BINARY))" npm test -- --coverage
	@$(CHECK_COV) vscode-extension "$$(jq '.total.lines.pct' $(VSCODE_DIR)/coverage/coverage-summary.json)"

test-dotnet: _build-dotnet
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

test-website:
	@echo "==> Running website Playwright tests..."
	cd website && npm ci && npx playwright install --with-deps chromium && npx playwright test

# ── Website screenshots ──────────────────────────────────────────

screenshots: _build-rust _build-dotnet _build-vsix
	@echo "==> Capturing all website screenshots from real VS Code..."
	cd $(VSCODE_DIR) && SHARPLSP_EXECUTABLE_PATH="$(abspath $(BINARY))" npm run screenshots

screenshot: _build-rust _build-dotnet _build-vsix
	@test -n "$(NAME)" || { echo "ERROR: use make screenshot NAME=diagnostics" >&2; exit 1; }
	@echo "==> Capturing website screenshot: $(NAME)"
	cd $(VSCODE_DIR) && SHARPLSP_EXECUTABLE_PATH="$(abspath $(BINARY))" npm run screenshots -- "$(NAME)"

# ── Lint ─────────────────────────────────────────────────────────

lint: build lint-rust lint-zed lint-vsix lint-dotnet
	@echo "==> All lints passed."

lint-rust:
	cargo fmt --check
	cargo clippy $(CARGO_FLAG) --all-targets -- -D warnings

lint-zed:
	cargo fmt --manifest-path $(ZED_DIR)/Cargo.toml --check
	cargo clippy --manifest-path $(ZED_DIR)/Cargo.toml --all-targets -- -D warnings

lint-vsix:
	npm run lint:eslint --prefix $(VSCODE_DIR)
	npm run typecheck --prefix $(VSCODE_DIR)

lint-dotnet:
	dotnet build $(SIDECAR_SLN) --configuration $(DOTNET_CFG) -warnaserror \
		/p:UseSharedCompilation=false /nodeReuse:false -maxcpucount:1

# ── Format ───────────────────────────────────────────────────────

fmt: fmt-rust fmt-zed fmt-vsix fmt-dotnet
	@echo "==> All formatting complete."

fmt-rust:
	cargo fmt

fmt-zed:
	cargo fmt --manifest-path $(ZED_DIR)/Cargo.toml

fmt-vsix:
	cd $(VSCODE_DIR) && npx prettier --write 'src/**/*.ts'

fmt-dotnet:
	dotnet csharpier format $(SIDECAR_SLN)/..
	dotnet format $(SIDECAR_SLN)

# ── Build primitives (private) ────────────────────────────────────

_build-rust:
	@echo "==> Building sharplsp-lsp ($(PROFILE))..."
	cargo build $(CARGO_FLAG)
	@test -f $(BINARY) || { echo "ERROR: $(BINARY) not found" >&2; exit 1; }

_build-dotnet:
	@echo "==> Building sidecars ($(DOTNET_CFG))..."
	dotnet publish $(SIDECAR_CS)/SharpLsp.Sidecar.CSharp.csproj --configuration $(DOTNET_CFG) --output $(SIDECAR_CS_OUT)
	dotnet publish $(SIDECAR_FS)/SharpLsp.Sidecar.FSharp.fsproj --configuration $(DOTNET_CFG) --output $(SIDECAR_FS_OUT)

_build-vsix:
	@echo "==> Bundling + packaging VS Code extension..."
	npm run build --prefix $(VSCODE_DIR)
	cd $(VSCODE_DIR) && npx @vscode/vsce package --no-dependencies -o ../../$(VSIX)

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

# ── Deploy primitives (private) ───────────────────────────────────

_deploy-rust:
	@echo "==> Installing sharplsp-lsp to $(BINDIR)/..."
	mkdir -p $(BINDIR)
	cp $(BINARY) $(BINDIR)/sharplsp-lsp
	chmod +x $(BINDIR)/sharplsp-lsp

_deploy-sidecars:
	@echo "==> Packing + installing sidecar tools..."
	-dotnet tool uninstall -g SharpLsp.Sidecar.CSharp 2>/dev/null || true
	-dotnet tool uninstall -g SharpLsp.Sidecar.FSharp 2>/dev/null || true
	rm -rf target/nupkgs
	dotnet pack $(SIDECAR_CS)/SharpLsp.Sidecar.CSharp.csproj -p:PackageVersion=0.0.0-local -c $(DOTNET_CFG) -o target/nupkgs
	dotnet pack $(SIDECAR_FS)/SharpLsp.Sidecar.FSharp.fsproj -p:PackageVersion=0.0.0-local -c $(DOTNET_CFG) -o target/nupkgs
	dotnet tool install -g SharpLsp.Sidecar.CSharp --version 0.0.0-local --add-source target/nupkgs
	dotnet tool install -g SharpLsp.Sidecar.FSharp --version 0.0.0-local --add-source target/nupkgs

_uninstall-vsix:
	@echo "==> Uninstalling existing SharpLsp extension..."
	-code --uninstall-extension sharplsp.sharp-lsp 2>/dev/null || true

_install-vsix:
	@echo "==> Installing $(VSIX)..."
	code --install-extension $(VSIX) --force

_stage-sidecars:
	@mkdir -p target/debug/sidecar-csharp target/debug/sidecar-fsharp
	@mkdir -p target/llvm-cov-target/debug/sidecar-csharp target/llvm-cov-target/debug/sidecar-fsharp
	@cp -r $(SIDECAR_CS_OUT)/. target/debug/sidecar-csharp/
	@cp -r $(SIDECAR_FS_OUT)/. target/debug/sidecar-fsharp/
	@cp -r $(SIDECAR_CS_OUT)/. target/llvm-cov-target/debug/sidecar-csharp/
	@cp -r $(SIDECAR_FS_OUT)/. target/llvm-cov-target/debug/sidecar-fsharp/

_kill:
	@echo "==> Killing stale sharplsp processes..."
	-@pkill -9 -f 'sharplsp-lsp' 2>/dev/null || true
	-@pkill -9 -f 'SharpLsp\.Sidecar\.' 2>/dev/null || true
	@sleep 0.5

# ── Clean ─────────────────────────────────────────────────────────

clean: _clean-rider
	@echo "==> Cleaning build artifacts..."
	cargo clean
	cargo clean --manifest-path $(ZED_DIR)/Cargo.toml
	rm -rf $(SIDECAR_CS_OUT) $(SIDECAR_FS_OUT)
	rm -rf $(VSCODE_DIR)/bin $(VSCODE_DIR)/dist $(VSCODE_DIR)/out
	rm -rf $(ZED_PKG_DIR)
	rm -f $(VSIX) $(ZED_PKG_TAR)
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
