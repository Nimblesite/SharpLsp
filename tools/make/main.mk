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
#   make website-build                build the website
#   make website-test                 test the website in Playwright
#   make website-dev                  serve the website locally
#   make install-dotnet-10             install a user-local .NET 10 SDK + runtime
#   make uninstall-dotnet-10           remove the user-local .NET 10 SDK + runtime
#   make package-vsix-linux-x64 [VERSION=x.y.z]     build + package VSIX for linux-x64
#   make package-vsix-linux-arm64 [VERSION=x.y.z]   build + package VSIX for linux-arm64
#   make package-vsix-darwin-arm64 [VERSION=x.y.z]  build + package VSIX for darwin-arm64
#   make package-vsix-darwin-x64 [VERSION=x.y.z]    build + package VSIX for darwin-x64
#   make package-vsix-win32-x64 [VERSION=x.y.z]     build + package VSIX for win32-x64
#   make package-vsix-win32-arm64 [VERSION=x.y.z]   build + package VSIX for win32-arm64
#
#   VERSION is optional for all package-vsix-* targets; it defaults to the
#   0.0.0 placeholder when omitted.
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
# Keep the test host's startup banner observable even when a developer's shell
# exports a quieter RUST_LOG. Tests may opt into another filter explicitly via
# RUST_TEST_LOG without inheriting editor/session logging preferences.
RUST_TEST_LOG     ?= info
# [DIST-CI-RUST-SHARDS] CI splits the Rust e2e suite into nextest hash
# partitions (`_test-rust-shard`); SHARD_COUNT is the total number of slices.
SHARD_COUNT       ?= 2
PLAYWRIGHT_DEPS_FLAG = $(if $(filter windows,$(DETECTED_OS)),,--with-deps)

VSCODE_DIR  = src/editors/vscode
ZED_DIR     = src/editors/zed
SIDECAR_CS  = src/sidecars/SharpLsp.Sidecar.CSharp
SIDECAR_FS  = src/sidecars/SharpLsp.Sidecar.FSharp
SIDECAR_SLN = src/sidecars/SharpLsp.Sidecars.sln
RIDER_DIR   = src/editors/rider

BINARY         = target/$(PROFILE)/sharplsp$(EXE_EXT)
SIDECAR_CS_OUT = target/sidecar-csharp
SIDECAR_FS_OUT = target/sidecar-fsharp
ZED_WASM       = $(ZED_DIR)/target/wasm32-wasip1/$(PROFILE)/sharplsp_zed.wasm
ZED_PKG_DIR    = target/zed-extension
DIST_DIR       = dist
DEV_VSIX       = $(DIST_DIR)/sharplsp.vsix
ZED_PKG_TAR    = $(DIST_DIR)/sharplsp-zed-extension.tar.gz
RIDER_ZIP      = $(DIST_DIR)/sharplsp-rider.zip

# Host platform for local VSIX dev builds
HOST_PLATFORM = $(shell node -e "process.stdout.write(process.platform + '-' + process.arch)")
HOST_VSIX_BIN = $(VSCODE_DIR)/bin/$(HOST_PLATFORM)/sharplsp$(EXE_EXT)

PREFIX   ?= $(HOME)/.local
BINDIR    = $(PREFIX)/bin
CHECK_COV = node tools/coverage/check-coverage.mjs
# Resolves a JDK 21+ and runs a Gradle task in the Rider project. [DIST-CI-RIDER]
RIDER_GRADLE = sh tools/rider/gradle.sh
MERGE_COBERTURA = dotnet run --file tools/coverage/merge-cobertura.cs --
KOVER_PERCENT = dotnet run --file tools/coverage/kover-line-percent.cs --

.PHONY: build ci test lint fmt clean setup screenshots website-build website-test website-dev \
        install-dotnet-10 uninstall-dotnet-10 \
        package-vsix-linux-x64 package-vsix-linux-arm64 \
        package-vsix-darwin-arm64 package-vsix-darwin-x64 \
        package-vsix-win32-x64 package-vsix-win32-arm64 \
        print-publish-commands \
        _stamp-version \
        _build-rust _build-dotnet _build-vsix _build-zed _build-rider \
        _stage-vsix-binary _stage-vsix-binary-only _stage-sidecars \
        test-rust _test-rust _prepare-rust-tests _test-rust-shard \
        test-zed _test-zed test-rider _test-rider \
        _gate-rust-coverage _test-vsix _test-vsix-win _check-vsix-chunks \
        _test-dotnet _test-website \
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
	mkdir -p $(DIST_DIR)
	cd $(VSCODE_DIR) && npx @vscode/vsce package --no-dependencies -o ../../../$(DEV_VSIX)
	rm -rf $(VSCODE_DIR)/bin

_build-zed:
	@echo "==> Building Zed extension..."
	@rustup target list --installed | grep -q wasm32-wasip1 || rustup target add wasm32-wasip1
	cargo build $(CARGO_FLAG) --manifest-path $(ZED_DIR)/Cargo.toml --target wasm32-wasip1
	@test -f $(ZED_WASM) || { echo "ERROR: $(ZED_WASM) not found" >&2; exit 1; }
	@rm -rf $(ZED_PKG_DIR) && mkdir -p $(ZED_PKG_DIR)
	mkdir -p $(DIST_DIR)
	cp $(ZED_DIR)/extension.toml $(ZED_DIR)/Cargo.toml $(ZED_DIR)/Cargo.lock $(ZED_PKG_DIR)/
	cp -R $(ZED_DIR)/src $(ZED_PKG_DIR)/src
	rm -f $(ZED_PKG_TAR) && tar -czf $(ZED_PKG_TAR) -C $(dir $(ZED_PKG_DIR)) $(notdir $(ZED_PKG_DIR))

_build-rider:
	@$(RIDER_GRADLE) buildPlugin
	@zip=$$(ls $(RIDER_DIR)/build/distributions/sharplsp-rider-*.zip 2>/dev/null | head -n1); \
		if [ -n "$$zip" ]; then \
			mkdir -p $(DIST_DIR) && cp "$$zip" $(RIDER_ZIP); \
		elif [ -n "$${RIDER_REQUIRED:-}" ]; then \
			echo "ERROR: no Rider plugin zip in $(RIDER_DIR)/build/distributions/" >&2; exit 1; \
		fi

_stage-vsix-binary: _build-rust _build-dotnet
	@$(MAKE) _stage-vsix-binary-only

# Staging with the build prerequisites stripped off. CI's Windows VSIX feature
# chunks ([DIST-CI-WIN-VSIX]) download the host binary + both sidecars as
# artifacts from a single build job and fan out, so each chunk must stage what
# is already on disk instead of rebuilding Rust and .NET seven times over.
_stage-vsix-binary-only:
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
	@$(VERIFY_STAGED_SIDECARS)
	@bash tools/vsix/fetch-netcoredbg.sh $(HOST_PLATFORM)

# A .NET apphost is only a launcher: strip SharpLsp.Sidecar.<lang>.dll from beside
# it and the executable still EXISTS but cannot run. Every copy/rename above is
# best-effort (`2>/dev/null || true`), and a publish raced by a concurrent rebuild
# can hand us an incomplete tree, so "the file is there" proves nothing.
#
# Without this check such a stage packages cleanly, passes the existence tests, and
# only fails on the user's machine: shipwright runs `--version` (its
# `versionCheckStrategy`), rejects the unusable `bundled` source, falls through to
# the `path` source and reports "required binaries are missing" against whatever
# unrelated PATH directory it tried last. Fail here instead. [DIST-FAILURE-UX]
VERIFY_STAGED_SIDECARS = \
	for sidecar in sharplsp-sidecar-csharp sharplsp-sidecar-fsharp; do \
		out="$$("$(VSCODE_DIR)/bin/all/$$sidecar$(EXE_EXT)" --version 2>&1)" || { \
			echo "ERROR: staged $$sidecar does not run: $$out" >&2; \
			echo "       The apphost is staged without its managed assembly, or the" >&2; \
			echo "       publish output was incomplete. Re-run: make _build-dotnet" >&2; \
			exit 1; \
		}; \
		echo "    verified $$out"; \
	done

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

test: _test-rust _test-zed _test-vsix _test-dotnet _test-rider _test-website
	@echo "==> All tests passed."

# Public alias — CI and developers call this.
test-rust: _test-rust
test-zed: _test-zed
test-rider: _test-rider

# The e2e tests spawn the real sidecars from these paths.
RUST_E2E_SIDECARS = \
	RUST_LOG="$(RUST_TEST_LOG)" \
	SHARPLSP_CSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_CS_OUT))/SharpLsp.Sidecar.CSharp$(EXE_EXT)" \
	SHARPLSP_FSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_FS_OUT))/SharpLsp.Sidecar.FSharp$(EXE_EXT)"

_prepare-rust-tests: _build-dotnet _stage-sidecars
	@echo "==> Pre-building ProfileTarget fixture..."
	dotnet build src/sharplsp/tests/fixtures/ProfileTarget/ProfileTarget.csproj -c Release --nologo -v q

_test-rust: _prepare-rust-tests
	@echo "==> Running sharplsp tests with coverage..."
	# --no-fail-fast is an intentional repository test-rule exception: coverage
	# enforcement requires every test to run so the measured line percentage is
	# complete; stopping at the first failure would under-report coverage and make
	# the threshold gate meaningless. A real test failure still fails the build via
	# nextest's non-zero exit, which then fails `make test`.
	$(RUST_E2E_SIDECARS) \
		cargo llvm-cov nextest --json --output-path target/coverage-rust.json --no-fail-fast --test-threads $(RUST_TEST_THREADS)
	@$(CHECK_COV) sharplsp --json target/coverage-rust.json data.0.totals.lines.percent

# The Zed extension is a standalone workspace (it targets wasm32-wasip1), so it
# is invisible to the root `cargo llvm-cov` run and needs its own gate. Its unit
# tests build for the host, which is why they can run here at all.
#
# `lib.rs` keeps a floor of uncoverable lines: the `zed::Extension` trait impl,
# `register_extension!`, and every function taking a `zed::Worktree` only exist
# inside Zed's WASM host. The logic behind them lives in `pipeline.rs` precisely
# so it is reachable from a test.
_test-zed:
	@echo "==> Running Zed extension tests with coverage..."
	# The Zed workspace builds into $(ZED_DIR)/target, so on a fresh checkout the
	# root target/ that holds every other coverage artifact does not exist yet
	# and llvm-cov cannot write the report into it.
	@mkdir -p target
	cargo llvm-cov --manifest-path $(ZED_DIR)/Cargo.toml \
		--json --output-path target/coverage-zed.json
	@$(CHECK_COV) sharplsp-zed --json target/coverage-zed.json data.0.totals.lines.percent

# [DIST-CI-RUST-SHARDS] One CI slice of the suite: identical tests, identical
# serialization (RUST_TEST_THREADS), but only the hash:$(SHARD)/$(SHARD_COUNT)
# nextest partition. Exports lcov instead of JSON so _gate-rust-coverage can
# union the shards. The coverage gate deliberately does NOT run here — a
# partition can never meet the full-suite threshold on its own.
_test-rust-shard: _prepare-rust-tests
	@test -n "$(SHARD)" || { echo "ERROR: SHARD is required (e.g. make _test-rust-shard SHARD=1)" >&2; exit 1; }
	@echo "==> Running sharplsp test shard $(SHARD)/$(SHARD_COUNT) with coverage..."
	$(RUST_E2E_SIDECARS) \
		cargo llvm-cov nextest --lcov --output-path target/coverage-rust-shard$(SHARD).lcov \
			--no-fail-fast --test-threads $(RUST_TEST_THREADS) --partition hash:$(SHARD)/$(SHARD_COUNT)

# [DIST-CI-RUST-SHARDS] Union-merge the shard tracefiles and enforce the same
# ratcheted threshold a single-job run enforces.
_gate-rust-coverage:
	@PERCENT="$$(node tools/coverage/merge-lcov.mjs target/coverage-rust.lcov target/coverage-rust-shard*.lcov)" && \
		$(CHECK_COV) sharplsp "$$PERCENT"

# Every SharpLsp path override the extension honours, cleared so the test host
# resolves ONLY the freshly-staged bundled binaries — never a dev copy that
# leaked onto PATH or into the environment.
VSIX_TEST_ENV = env -u SHARPLSP_EXECUTABLE_PATH \
	-u SHARPLSP_LSP_PATH \
	-u SHARPLSP_BINARY_DIR \
	-u SHARPLSP_CSHARP_SIDECAR_PATH \
	-u SHARPLSP_FSHARP_SIDECAR_PATH \
	-u FORGE_LSP_PATH \
	-u FORGE_BINARY_DIR

_test-vsix: _build-rust _build-dotnet _build-vsix _stage-vsix-binary
	@echo "==> Running VS Code extension tests..."
	@$(MAKE) _stage-vsix-binary
	status=0; \
	cd $(VSCODE_DIR); \
	$(VSIX_TEST_ENV) npm test -- --coverage || status=$$?; \
	rm -rf "$(abspath $(VSCODE_DIR))/bin" || true; \
	exit $$status
	@$(CHECK_COV) vscode-extension --json $(VSCODE_DIR)/coverage/coverage-summary.json total.lines.pct

# ── VSIX Windows feature chunks ───────────────────────────────────
# [DIST-CI-WIN-VSIX] Runs ONE declared feature chunk of the VS Code end-to-end
# suite — the same suites the Ubuntu `_test-vsix` job runs, sliced so each
# chunk is one parallel Windows CI job. Every chunk drives the REAL LSP
# (sharplsp host + Roslyn/FCS sidecars) through the actual VS Code extension
# host over win32 named-pipe IPC, which the Linux-only `_test-vsix` job can
# never exercise (same rationale as test-dotnet-windows /
# [DIST-CI-WIN-TRANSPORT], one level up: that job checks the pipes, these check
# the whole editor experience on top of them — debugging, profiling, the test
# explorer, the solution tree, scaffolding, NuGet, and both languages' LSP).
#
# Chunk membership lives in src/editors/vscode/test-chunks.json (single source of
# truth, never duplicated into CI YAML); tools/vsix/vsix-test-chunks.mjs turns a
# chunk name into the MOCHA_FILES glob list the inner mocha runner applies, and
# `_check-vsix-chunks` fails lint if any suite escapes every chunk.
#
# Deliberately runs WITHOUT --coverage and skips the coverage gate: one chunk
# can't meet the line threshold, so the Ubuntu `_test-vsix` job owns coverage.
VSIX_CHUNKS = node tools/vsix/vsix-test-chunks.mjs

_check-vsix-chunks:
	@$(VSIX_CHUNKS) check

_test-vsix-win: _stage-vsix-binary-only
	@test -n "$(CHUNK)" || { echo "ERROR: CHUNK is required (e.g. make _test-vsix-win CHUNK=debug)" >&2; exit 1; }
	@echo "==> Running VS Code extension chunk '$(CHUNK)' (real LSP, no coverage)..."
	status=0; \
	files="$$($(VSIX_CHUNKS) files $(CHUNK))"; \
	cd $(VSCODE_DIR); \
	npm run pretest && $(VSIX_TEST_ENV) MOCHA_FILES="$$files" npx vscode-test || status=$$?; \
	rm -rf "$(abspath $(VSCODE_DIR))/bin" || true; \
	exit $$status

# [DIST-CI-RIDER] The Rider plugin's only automated verification. Skipped
# locally when no JDK 21+ is installed; CI sets RIDER_REQUIRED=1 so it can never
# silently skip there — a skipped gate that reports green is worse than none.
_test-rider:
	@$(RIDER_GRADLE) koverXmlReport
	@report="$(RIDER_DIR)/build/reports/kover/report.xml"; \
	 if [ -f "$$report" ]; then \
	   pct=$$($(KOVER_PERCENT) "$$report") && $(CHECK_COV) sharplsp-rider "$$pct"; \
	 elif [ -n "$${RIDER_REQUIRED:-}" ]; then \
	   echo "ERROR: no Kover report at $$report" >&2; exit 1; \
	 fi

_test-dotnet: _build-dotnet
	@echo "==> Running .NET sidecar tests..."
	@rm -rf target/coverage-dotnet
	dotnet test $(SIDECAR_SLN) --configuration $(DOTNET_CFG) \
		--collect:"XPlat Code Coverage" \
		--results-directory target/coverage-dotnet \
		--settings .config/coverage/coverlet.runsettings \
		-- RunConfiguration.FailFastEnabled=true
	@_check_cov() { \
	   local pkg=$$1 label=$$2 ; \
	   pct=$$($(MERGE_COBERTURA) "$$pkg" target/coverage-dotnet/*/coverage.cobertura.xml) ; \
	   $(CHECK_COV) "$$label" "$$pct" ; \
	 } ; \
	 _check_cov SharpLsp.Sidecar.CSharp sharplsp-sidecar-csharp ; \
	 _check_cov SharpLsp.Sidecar.FSharp sharplsp-sidecar-fsharp ; \
	 _check_cov SharpLsp.Sidecar.Common sharplsp-sidecar-common

website-build:
	@echo "==> Building website..."
	npm run build --prefix src/website

website-test: _test-website

website-dev:
	@echo "==> Starting website development server..."
	npm run dev --prefix src/website

_test-website:
	@echo "==> Running website Playwright tests..."
	npm ci --prefix src/website
	npm exec --prefix src/website -- playwright install $(PLAYWRIGHT_DEPS_FLAG) chromium webkit
	# Use Playwright's serialized CI mode locally too. The locale-parity matrix
	# performs many navigations per page and is intentionally deterministic in CI.
	CI=1 npm test --prefix src/website

# ── Lint ─────────────────────────────────────────────────────────

lint: build _lint-rust _lint-zed _lint-vsix _lint-dotnet
	@echo "==> All lints passed."

_lint-rust:
	cargo fmt --check
	cargo clippy $(CARGO_FLAG) --all-targets -- -D warnings

_lint-zed:
	cargo fmt --manifest-path $(ZED_DIR)/Cargo.toml --check
	cargo clippy --manifest-path $(ZED_DIR)/Cargo.toml --all-targets -- -D warnings

_lint-vsix: _check-vsix-chunks
	npm run lint:eslint --prefix $(VSCODE_DIR)
	npm run typecheck --prefix $(VSCODE_DIR)

# Dash-form MSBuild switches only: Git Bash (MSYS) mangles slash-form switches
# like `/p:...` on Windows (strips the `/`, MSBuild then reads it as a project
# path and fails with MSB1008). Dash-form behaves identically on all platforms.
_lint-dotnet:
	dotnet build $(SIDECAR_SLN) --configuration $(DOTNET_CFG) -warnaserror \
		-p:UseSharedCompilation=false -nodeReuse:false -maxcpucount:1

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
	dotnet csharpier format $(dir $(SIDECAR_SLN))
	dotnet format $(SIDECAR_SLN)

# ── Screenshots ───────────────────────────────────────────────────

screenshots: _build-rust _build-dotnet _build-vsix
	@echo "==> Capturing all website screenshots from real VS Code..."
	# MUST re-stage in a fresh make process, exactly as _test-vsix does. Listing
	# _stage-vsix-binary as a prerequisite does NOT work: _build-vsix already
	# depends on it, so make marks it updated and skips it here — and the last
	# thing _build-vsix's recipe does is `rm -rf $(VSCODE_DIR)/bin`. Without this
	# line the screenshot run starts with no bundled binary at all, activation is
	# blocked by shipwright, and every capture comes out empty.
	@$(MAKE) _stage-vsix-binary-only
	(cd $(VSCODE_DIR) && node src/test/suite/screenshot-watcher.mjs) & \
	WATCHER_PID=$$!; \
	cd $(VSCODE_DIR) && \
		env -u SHARPLSP_EXECUTABLE_PATH \
			-u SHARPLSP_LSP_PATH \
			-u SHARPLSP_BINARY_DIR \
			SHARPLSP_SCREENSHOTS=1 \
			SHARPLSP_CSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_CS_OUT))/SharpLsp.Sidecar.CSharp$(EXE_EXT)" \
			SHARPLSP_FSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_FS_OUT))/SharpLsp.Sidecar.FSharp$(EXE_EXT)" \
			npm test -- --coverage; \
	STATUS=$$?; \
	kill $$WATCHER_PID 2>/dev/null || true; \
	rm -rf "$(abspath $(VSCODE_DIR))/bin"; \
	exit $$STATUS

# ── Version stamping ─────────────────────────────────────────────
# Rewrites the version field in all manifest files before a package build.
# Invoked only by the package-vsix-* targets, which supply VERSION (defaulting
# to the 0.0.0 placeholder when the caller omits it — see PACKAGE_VSIX_TARGETS).

_stamp-version:
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
	@rm -f Cargo.toml.bak $(ZED_DIR)/Cargo.toml.bak $(ZED_DIR)/extension.toml.bak
	@echo "==> Version $(VERSION) stamped."

# ── Package VSIX (per platform) ───────────────────────────────────
# [BINARY-RELEASE] Builds the Rust binary for the given target triple, stages it, and packages
# a platform-specific VSIX into dist/.
#
# Usage:
#   make package-vsix-darwin-arm64                  (VERSION defaults to 0.0.0)
#   make package-vsix-darwin-arm64 VERSION=0.3.0
#   make package-vsix-darwin-arm64 RUST_TARGET=aarch64-apple-darwin VERSION=0.3.0
#
# VERSION is optional (defaults to the 0.0.0 placeholder) and is stamped into
# all manifests before building.
# RUST_TARGET defaults to the canonical triple for each platform.

package-vsix-linux-x64:   RUST_TARGET ?= x86_64-unknown-linux-gnu
package-vsix-linux-arm64:  RUST_TARGET ?= aarch64-unknown-linux-gnu
package-vsix-darwin-arm64: RUST_TARGET ?= aarch64-apple-darwin
package-vsix-darwin-x64:   RUST_TARGET ?= x86_64-apple-darwin
package-vsix-win32-x64:    RUST_TARGET ?= x86_64-pc-windows-msvc
package-vsix-win32-arm64:  RUST_TARGET ?= aarch64-pc-windows-msvc

PACKAGE_VSIX_TARGETS = \
	package-vsix-linux-x64 package-vsix-linux-arm64 \
	package-vsix-darwin-arm64 package-vsix-darwin-x64 \
	package-vsix-win32-x64 package-vsix-win32-arm64

# VERSION is optional and scoped to packaging ONLY. As a target-specific
# variable it also reaches the _stamp-version prerequisite and the recursive
# _build-dotnet / _package-vsix sub-makes, so the whole package build shares one
# version. When the caller omits it, the 0.0.0 placeholder is stamped (valid
# SemVer, no '-', so it never trips the --pre-release path). It is deliberately
# NOT a global default: standalone build/test invocations leave VERSION empty so
# each project keeps its committed baseline version and the sidecar `--version`
# contract (test-dotnet) holds. A release passes VERSION=x.y.z, overriding this.
$(PACKAGE_VSIX_TARGETS): VERSION ?= 0.0.0

$(PACKAGE_VSIX_TARGETS): _stamp-version
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
	@bash tools/vsix/fetch-netcoredbg.sh $(VSIX_PLAT)
	npm run build --prefix $(VSCODE_DIR)
	mkdir -p dist
	# vsce/ovsx refuse to PUBLISH with --pre-release unless the VSIX was also
	# PACKAGED with --pre-release (it sets preRelease=true in the embedded
	# manifest). A hyphenated SemVer VERSION (e.g. 0.2.0-rc.1) is a prerelease.
	cd $(VSCODE_DIR) && npx @vscode/vsce package --no-dependencies \
		$(if $(findstring -,$(VERSION)),--pre-release,) \
		--target $(VSIX_PLAT) \
		-o ../../../dist/sharplsp-$(VSIX_PLAT).vsix
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
	rm -rf $(ZED_PKG_DIR) $(DIST_DIR)
	rm -f $(DEV_VSIX) $(ZED_PKG_TAR)
	@echo "==> Clean."

_clean-rider:
	@$(RIDER_GRADLE) clean || true
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

ifeq ($(DETECTED_OS),windows)

install-dotnet-10:
	@echo "==> Installing .NET 10 SDK + runtime for the current Windows user..."
	powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/dotnet-10.ps1 -Action Install

uninstall-dotnet-10:
	@echo "==> Uninstalling user-local .NET 10 SDK + runtime..."
	powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/dotnet-10.ps1 -Action Uninstall

else

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

endif
