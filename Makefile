# SharpLsp build system
#
# This file IS the build system. Everything is here, so `make` finds the actions
# where `make` looks for them and a target list is one file long.
#
# The twelve targets below are the whole public surface. Every other target is
# prefixed `_`: an internal step of one of these, or a leg CI drives directly.
# The prefix is the whole convention - a tool listing this file's targets shows
# twelve, not seventy.
#
# Day to day:
#   make                              build everything (host platform, release)
#   make PROFILE=debug                build everything (debug)
#   make ci                           lint → test → build → audit
#   make test                         run all tests with coverage
#   make lint                         lint all languages
#   make fmt                          format all languages
#   make audit [AUDIT_LEVEL=moderate] vulnerable Rust/.NET/npm dependencies
#   make clean                        remove build artifacts
#
# Getting the change into your own VS Code:
#   make reinstall-vsix               THE rebuild loop. Uninstall the extension,
#                                     kill stale servers, clean, rebuild the Rust
#                                     host + both sidecars + the extension for the
#                                     platform you are on, package, reinstall.
#                                     macOS, Linux and Windows - it resolves the
#                                     host platform, so there is nothing to pick.
#   make install-vsix                 install dist/sharplsp.vsix as it stands
#   make uninstall-vsix               remove the installed extension
#
# First run on a new machine:
#   make setup                        install toolchain dependencies
#   make install-dotnet-10            install the .NET 10 SDK + runtime pinned in
#                                     global.json, when no dotnet on the machine
#                                     satisfies it
#
# Release packaging is CI's, not a developer's, so it is private:
# `_package-vsix-<platform>` for each of linux-x64, linux-arm64, darwin-arm64,
# darwin-x64, win32-x64 and win32-arm64, each building the Rust host and both
# sidecars ONCE and emitting that platform's VSIX and its standalone server
# archive ([DIST-ARCHIVE]); VERSION is optional and defaults to 0.0.0. Then
# `_print-publish-commands`. Also private: `_screenshots`, `_website-build`,
# `_website-dev`, `_test-website` and `_uninstall-dotnet-10`.

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
# [DIST-VSIX-REBUILD] Cleaning must never race a sibling build/test recipe.
.NOTPARALLEL:

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
SIDECAR_COMMON_TESTS = src/sidecars/SharpLsp.Sidecar.Common.Tests/SharpLsp.Sidecar.Common.Tests.csproj
RIDER_DIR   = src/editors/rider

BINARY         = target/$(if $(RUST_TARGET),$(RUST_TARGET)/,)$(PROFILE)/sharplsp$(EXE_EXT)
SIDECAR_CS_OUT = target/sidecar-csharp
SIDECAR_FS_OUT = target/sidecar-fsharp
ZED_WASM       = $(ZED_DIR)/target/wasm32-wasip1/$(PROFILE)/sharplsp_zed.wasm
ZED_PKG_DIR    = target/zed-extension
DIST_DIR       = dist
DEV_VSIX       = $(DIST_DIR)/sharplsp.vsix
ZED_PKG_TAR    = $(DIST_DIR)/sharplsp-zed-extension.tar.gz
RIDER_ZIP      = $(DIST_DIR)/sharplsp-rider.zip
# [DIST-ARCHIVE] Staging root for the standalone server archives. Kept under
# target/ so `cargo clean` and `make clean` reclaim it with everything else.
ARCHIVE_STAGE  = target/archive

# Host platform for local VSIX dev builds
HOST_PLATFORM = $(shell node -e "process.stdout.write(process.platform + '-' + process.arch)")
VSIX_PLAT ?= $(HOST_PLATFORM)
HOST_VSIX_BIN = $(VSCODE_DIR)/bin/$(VSIX_PLAT)/sharplsp$(EXE_EXT)

PREFIX   ?= $(HOME)/.local
BINDIR    = $(PREFIX)/bin
CHECK_COV = node tools/coverage/check-coverage.mjs
# Resolves a JDK 21+ and runs a Gradle task in the Rider project. [DIST-CI-RIDER]
RIDER_GRADLE = sh tools/rider/gradle.sh
MERGE_COBERTURA = $(DOTNET) run --file tools/coverage/merge-cobertura.cs --
KOVER_PERCENT = $(DOTNET) run --file tools/coverage/kover-line-percent.cs --

# The public surface. Everything under it is an internal step or a CI leg.
.PHONY: build ci test lint fmt clean audit setup \
        reinstall-vsix install-vsix uninstall-vsix install-dotnet-10

.PHONY: _screenshots _website-build _website-dev _uninstall-dotnet-10 \
        _package-vsix-linux-x64 _package-vsix-linux-arm64 \
        _package-vsix-darwin-arm64 _package-vsix-darwin-x64 \
        _package-vsix-win32-x64 _package-vsix-win32-arm64 \
        _print-publish-commands \
        _stamp-version \
        _build-rust _build-dotnet _build-vsix _build-zed _build-rider \
        _stage-vsix-binary _stage-vsix-binary-only _stage-sidecars \
        _test-rust _prepare-rust-tests _test-rust-shard \
        _test-zed _test-rider \
        _gate-rust-coverage _test-vsix _run-vsix-suite _test-vsix-shard \
        _gate-vsix-coverage _build-vsix-suite _check-vsix-chunks \
        _verify-vsix-payload _verify-staged-vsix-payload _rebuild-vsix-binaries _copy-vsix-binaries \
        _test-dotnet _test-dotnet-win-transport _test-tooling _test-website \
        _lint-rust _lint-zed _lint-vsix _lint-dotnet \
        _fmt-rust _fmt-zed _fmt-vsix _fmt-dotnet \
        _package-vsix _package-archive \
        _deploy-rust _deploy-sidecars \
        _kill _clean-rider _clean-artifacts

# The sidecars build against the SDK pinned in global.json ([DIST-RUNTIME-ACQUIRE]).
# `dotnet --list-sdks | grep '^10\.'` was never that check: a 10.0.2xx SDK passes
# it, and then `dotnet publish` dies with a bare exit 155, because `rollForward:
# latestPatch` does not cross SDK feature bands. So let the dotnet host evaluate
# the pin itself - `dotnet --version` reads global.json - and ask that of EVERY
# dotnet root on the machine, not only the one that happens to be on PATH.
#
# A satisfying SDK in ~/.dotnet next to a stale one in /usr/local/share/dotnet is
# the ordinary state of a macOS dev machine, and there is nothing in it for a
# developer to decide: the build USES the root that satisfies the pin instead of
# stopping to tell them which one they should have put on PATH first. Only a
# machine where NO root satisfies it is a real missing-SDK error.
#
# The choice is exported, not just used here, so MSBuild, the sidecars, the test
# hosts and every other child process run against the same SDK the build
# resolved. It is probed once per make process and inherited by the recursive
# sub-makes, so a reinstall does not re-probe every candidate at each level.
ifeq ($(origin SHARPLSP_DOTNET_ROOT),undefined)
SHARPLSP_DOTNET_ROOT := $(shell \
	on_path="$$(command -v dotnet$(EXE_EXT) 2>/dev/null)"; \
	for root in "$${on_path:+$$(dirname "$$on_path")}" "$$HOME/.dotnet" \
		/usr/local/share/dotnet "$$LOCALAPPDATA/Microsoft/dotnet" \
		"$$ProgramFiles/dotnet"; do \
		[ -n "$$root" ] && [ -x "$$root/dotnet$(EXE_EXT)" ] || continue; \
		DOTNET_ROOT="$$root" "$$root/dotnet$(EXE_EXT)" --version >/dev/null 2>&1 || continue; \
		echo "$$root"; break; \
	done)
endif
export SHARPLSP_DOTNET_ROOT

ifneq ($(SHARPLSP_DOTNET_ROOT),)
export DOTNET_ROOT := $(SHARPLSP_DOTNET_ROOT)
# The resolved root must WIN the lookup, not merely appear on PATH.
#
# `$(DOTNET)` is absolute, so every recipe in this file is immune — but the
# tools those recipes spawn are not. build-test-fixtures.mjs, the audit's
# dotnet-vulnerable.mjs and the packaging scripts all run a BARE `dotnet`, and a
# bare `dotnet` is whatever PATH names first. A machine carrying a stale root
# ahead of a good one (`export PATH="$DOTNET_ROOT:$PATH"` in a shell profile,
# pointing at /usr/local/share/dotnet) is "already present" and loses every
# lookup, so testing presence skipped the prepend in precisely the configuration
# it exists to fix.
#
# The test is delegated to the SHELL rather than done with `firstword`, because
# every make word function splits on whitespace and the Windows default root is
# `/c/Program Files/dotnet`. `firstword` read its head as `/c/Program`, which
# never equals the root, so the guard prepended again at every level of a
# recursive build - unbounded PATH growth, and the precedence it exists to
# assert never actually checked. `$${PATH%%:*}` compares the whole first entry.
# A `case` glob cannot be used here: make counts parentheses inside
# `$(shell ...)`, so the `)` closing a case pattern terminates the call.
#
# Testing precedence also gets the duplicate-free property the presence test was
# reaching for: after one prepend the root leads, so a nested sub-make compares
# equal and skips it.
ifneq ($(shell [ "$${PATH%%:*}" = "$(SHARPLSP_DOTNET_ROOT)" ] && echo led),led)
export PATH := $(SHARPLSP_DOTNET_ROOT):$(PATH)
endif
endif

# QUOTED, because the resolved root routinely contains a space: the Windows
# installer's default is `C:\Program Files\dotnet`, which Git Bash hands to make
# as `/c/Program Files/dotnet`. Unquoted, every recipe below splits it and the
# shell runs `/c/Program` - exit 127, and `_build-dotnet` died before it
# compiled anything. Ubuntu cannot reproduce it: /usr/share/dotnet has no space.
DOTNET = "$(if $(SHARPLSP_DOTNET_ROOT),$(SHARPLSP_DOTNET_ROOT)/,)dotnet$(EXE_EXT)"

CHECK_DOTNET_PIN = \
	if [ -z "$$SHARPLSP_DOTNET_ROOT" ]; then \
		echo "ERROR: no dotnet on this machine satisfies the SDK pinned in global.json." >&2; \
		$(DOTNET) --version 2>&1 | sed 's/^/       /' >&2 || true; \
		echo "       Install the pinned SDK with: make install-dotnet-10" >&2; \
		exit 1; \
	fi; \
	echo "==> SDK: $$("$$SHARPLSP_DOTNET_ROOT/dotnet$(EXE_EXT)" --version) from $$SHARPLSP_DOTNET_ROOT"

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
	cargo build $(CARGO_FLAG) $(if $(RUST_TARGET),--target $(RUST_TARGET),)
	@test -f $(BINARY) || { echo "ERROR: $(BINARY) not found" >&2; exit 1; }

_build-dotnet:
	@$(CHECK_DOTNET_PIN)
	@echo "==> Building sidecars ($(DOTNET_CFG))..."
	$(DOTNET) publish $(SIDECAR_CS)/SharpLsp.Sidecar.CSharp.csproj --configuration $(DOTNET_CFG) --no-self-contained -p:DebugType=none -p:DebugSymbols=false $(if $(VERSION),-p:Version=$(VERSION) -p:PackageVersion=$(VERSION),) --output $(SIDECAR_CS_OUT)
	$(DOTNET) publish $(SIDECAR_FS)/SharpLsp.Sidecar.FSharp.fsproj --configuration $(DOTNET_CFG) --no-self-contained -p:DebugType=none -p:DebugSymbols=false $(if $(VERSION),-p:Version=$(VERSION) -p:PackageVersion=$(VERSION),) --output $(SIDECAR_FS_OUT)

# [DIST-VSIX-CONTENTS] The gate runs BEFORE the package, not after: `vsce ls` is
# the same file list `vsce package` writes, so verifying the staged tree is
# verifying the artifact, and doing it first means a half-stage never becomes a
# VSIX that `install-vsix` will happily push into VS Code. Every copy and rename
# in `_stage-vsix-binary-only` ends in `2>/dev/null || true`, so a stage that
# half-ran looks exactly like one that worked; without this the developer meets
# the hole as an activation failure. A sub-make, not a prerequisite, because
# this recipe ends by deleting the very `bin/` the verifier reads.
#
# `--target` because a package built without it carries no TargetPlatform, and
# VS Code then treats a VSIX holding exactly ONE platform's host binary and
# debug adapter as installable on every platform. Released VSIXes are always
# built with it, so omitting it here means the dev loop never exercises the
# shape that ships. [DIST-VSIX-DEV-INSTALL]
_build-vsix: $(if $(VSIX_PREBUILT),_stage-vsix-binary-only,_stage-vsix-binary)
	@echo "==> Packaging VS Code extension (host: $(HOST_PLATFORM))..."
	npm run build --prefix $(VSCODE_DIR)
	mkdir -p $(DIST_DIR)
	@$(MAKE) _verify-staged-vsix-payload
	cd $(VSCODE_DIR) && SHARPLSP_VSIX_PLATFORM=$(VSIX_PLAT) npx @vscode/vsce package --no-dependencies \
		--target $(HOST_PLATFORM) -o ../../../$(DEV_VSIX)
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

_rebuild-vsix-binaries:
	@$(CHECK_DOTNET_PIN)
	cargo clean --profile $(if $(filter debug,$(PROFILE)),dev,$(PROFILE)) $(if $(RUST_TARGET),--target $(RUST_TARGET),)
	node tools/vsix/clean-sidecar-output.mjs
	$(MAKE) _build-rust
	$(MAKE) _build-dotnet
	$(DOTNET) test $(SIDECAR_CS).Tests/SharpLsp.Sidecar.CSharp.Tests.csproj --configuration $(DOTNET_CFG) --filter FullyQualifiedName~Repo_pinned_sdk_ships_exactly_the_bundled_roslyn
	bash tools/vsix/build-netcoredbg.sh $(VSIX_PLAT) --rebuild

# [DIST-VSIX-REBUILD] Ordered sub-makes keep clean/build/copy sequential under
# make -j. This is the DEFAULT path: a local tree's incremental Rust and sidecar
# output is exactly what makes a VSIX test pass against a binary that no longer
# matches the source (#279), so nothing here trusts what is already on disk.
_stage-vsix-binary: _rebuild-vsix-binaries
	@$(MAKE) _copy-vsix-binaries

# [DIST-CI-VSIX-SHARDS] Staging what is already on disk, WITHOUT rebuilding.
# The staleness #279 describes is a property of an incremental local tree, not
# of a CI artifact: the binaries a shard downloads were built by the `build` job
# of THIS run from THIS commit, so they cannot be stale. Rebuilding Rust, both
# sidecars and netcoredbg once per shard would multiply that work by the matrix
# width and add hours to every PR, which is why CI - and only CI, by setting
# VSIX_PREBUILT - takes this path.
_stage-vsix-binary-only:
	@$(MAKE) _copy-vsix-binaries

_copy-vsix-binaries:
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
	@bash tools/vsix/fetch-netcoredbg.sh $(VSIX_PLAT)

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
# Creating target/llvm-cov-target before cargo does leaves it WITHOUT the
# CACHEDIR.TAG cargo writes for its own build directories, and
# `cargo llvm-cov clean` then refuses the directory ("missing or invalid
# CACHEDIR.TAG") and exits non-zero. Every later coverage run therefore piled
# fresh objects on top of stale ones, and the merged lcov mixed several crate
# disambiguators — which is how a clean tree measured 92.04% against a real
# 95.73%. Write the tag ourselves so the clean cargo would have done still works.
	@[ -f target/llvm-cov-target/CACHEDIR.TAG ] || printf '%s\n' \
		'Signature: 8a477f597d28d172789f06886806bc55' > target/llvm-cov-target/CACHEDIR.TAG
	@cp -r $(SIDECAR_CS_OUT)/. target/debug/sidecar-csharp/
	@cp -r $(SIDECAR_FS_OUT)/. target/debug/sidecar-fsharp/
	@cp -r $(SIDECAR_CS_OUT)/. target/llvm-cov-target/debug/sidecar-csharp/
	@cp -r $(SIDECAR_FS_OUT)/. target/llvm-cov-target/debug/sidecar-fsharp/
	@chmod +x target/debug/sidecar-csharp/SharpLsp.Sidecar.CSharp$(EXE_EXT) \
		target/debug/sidecar-fsharp/SharpLsp.Sidecar.FSharp$(EXE_EXT) \
		target/llvm-cov-target/debug/sidecar-csharp/SharpLsp.Sidecar.CSharp$(EXE_EXT) \
		target/llvm-cov-target/debug/sidecar-fsharp/SharpLsp.Sidecar.FSharp$(EXE_EXT) 2>/dev/null || true

# ── CI ────────────────────────────────────────────────────────────

ci: lint test build audit
	@echo "==> CI pipeline passed."

# ── Audit ─────────────────────────────────────────────────────────
#
# [DIST-CI-AUDIT] Dependency vulnerability audit.
#
#   make audit                    audit every dependency the repo ships or builds with
#   make audit AUDIT_LEVEL=low    fail on every advisory, not just moderate and above
#
# Each ecosystem is checked against its own advisory database:
#
#   Rust  cargo audit (RustSec)                    root workspace + Zed extension
#   .NET  dotnet list package --vulnerable         sidecar solution, transitive included
#   npm   npm audit                                VS Code extension + website
#
# Every finding names the vulnerable package, its version and the advisory;
# cargo audit and npm audit also print the version to upgrade to. All three
# scanners run even when an earlier one fails, so ONE run lists everything that
# needs upgrading. This exact target is the CI job (ci-audit.yml) that gates
# every PR and every release.
#
# npm audit reads package-lock.json only (--package-lock-only), so it never
# touches node_modules.

AUDIT_LEVEL       ?= moderate
AUDIT_CARGO_LOCKS  = Cargo.lock $(ZED_DIR)/Cargo.lock
AUDIT_NPM_DIRS     = $(VSCODE_DIR) src/website
AUDIT_DOTNET_JSON  = target/audit-dotnet.json

.PHONY: audit _audit-rust _audit-dotnet _audit-npm

audit:
	@status=0; \
	$(MAKE) --no-print-directory _audit-rust || status=1; \
	$(MAKE) --no-print-directory _audit-dotnet || status=1; \
	$(MAKE) --no-print-directory _audit-npm || status=1; \
	if [ $$status -ne 0 ]; then \
		echo "ERROR: vulnerable dependencies found - upgrade the packages reported above." >&2; \
		exit 1; \
	fi; \
	echo "==> No vulnerable dependencies at or above '$(AUDIT_LEVEL)'."

# cargo audit fails on any vulnerability. Yanked, unsound and unmaintained crates
# are printed as warnings but do not fail.
_audit-rust:
	@command -v cargo-audit >/dev/null || { \
		echo "ERROR: cargo-audit is not installed. Run: cargo install cargo-audit --locked" >&2; \
		exit 1; \
	}
	@status=0; for lock in $(AUDIT_CARGO_LOCKS); do \
		echo "==> cargo audit $$lock"; \
		cargo audit --file "$$lock" || status=1; \
	done; exit $$status

_audit-dotnet:
	@echo "==> dotnet list package --vulnerable $(SIDECAR_SLN)"
	@mkdir -p $(dir $(AUDIT_DOTNET_JSON))
	$(DOTNET) restore $(SIDECAR_SLN) --verbosity quiet
	$(DOTNET) list $(SIDECAR_SLN) package --vulnerable --include-transitive --format json > $(AUDIT_DOTNET_JSON)
	@node tools/audit/dotnet-vulnerable.mjs $(AUDIT_DOTNET_JSON) $(AUDIT_LEVEL)

_audit-npm:
	@status=0; for dir in $(AUDIT_NPM_DIRS); do \
		echo "==> npm audit $$dir (fails at $(AUDIT_LEVEL) and above)"; \
		(cd "$$dir" && npm audit --package-lock-only --audit-level=$(AUDIT_LEVEL)) || status=1; \
	done; exit $$status

# ── Test ─────────────────────────────────────────────────────────

test: _test-rust _test-zed _test-vsix _test-dotnet _test-rider _test-tooling _test-website
	@echo "==> All tests passed."

# The e2e tests spawn the real sidecars from these paths.
RUST_E2E_SIDECARS = \
	RUST_LOG="$(RUST_TEST_LOG)" \
	SHARPLSP_CSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_CS_OUT))/SharpLsp.Sidecar.CSharp$(EXE_EXT)" \
	SHARPLSP_FSHARP_SIDECAR_PATH="$(abspath $(SIDECAR_FS_OUT))/SharpLsp.Sidecar.FSharp$(EXE_EXT)"

_prepare-rust-tests: $(if $(VSIX_PREBUILT),,_build-dotnet) _stage-sidecars
	@echo "==> Pre-building ProfileTarget fixture..."
	$(DOTNET) build src/sharplsp/tests/fixtures/ProfileTarget/ProfileTarget.csproj -c Release --nologo -v q

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

# [DIST-CI-VSIX-SHARDS] ONE runner drives every slice of the VS Code end-to-end
# suite, on every platform, ALWAYS instrumented. It is parameterised by two
# variables, and nothing else differs between the local full run, the Ubuntu
# shards and the Windows shards:
#
#   CHUNK                a chunk name from src/editors/vscode/test-chunks.json.
#                        Empty runs EVERY suite - the inner runner reads an empty
#                        MOCHA_FILES as "all" - which is what a local `make test`
#                        wants.
#   Prebuilt flags cannot skip compilation ([DIST-VSIX-REBUILD]).
#
# Coverage is NOT a knob. Every shard on every platform instruments, and one gate
# at the end of the pipeline ratchets the union ([DIST-CI-VSIX-COVERAGE]); a
# shard that ran uninstrumented would silently shrink that union.
#
# Every shard compiles the suite and extension after its native rebuild.
VSIX_CHUNK_FILES = $(if $(CHUNK),$$($(VSIX_CHUNKS) files $(CHUNK)),)
# `pretest` has a PORTABLE half and a MACHINE-BOUND half.
#
# Portable: clean, tsc the suite, esbuild the bundle. Identical on every runner,
# minutes of work, and the whole reason `_build-vsix-suite` exists.
#
# Machine-bound: `prepare:test-fixtures` runs `dotnet build` over the fixture
# solution, and the `obj/project.assets.json` it writes points at THAT machine's
# `~/.nuget/packages`. Shipping the built fixtures between jobs hands a shard a
# workspace whose references cannot resolve, so Roslyn loads it degraded: no
# definitions, a reduced refactor set, and an empty unused-package report - all
# of which look like test failures rather than a missing restore. Every shard
# therefore builds the fixtures itself, restoring against its own NuGet cache.
VSIX_PRETEST = $(if $(VSIX_SUITE_PREBUILT),npm run prepare:test-fixtures,npm run prepare:tests)

define RUN_VSIX_SUITE
	status=0; \
	files="$(VSIX_CHUNK_FILES)"; \
	if [ -n "$(CHUNK)" ] && [ -z "$$files" ]; then \
		echo "ERROR: chunk '$(CHUNK)' resolved to no suites - refusing to silently run ALL of them" >&2; \
		exit 1; \
	fi; \
	cd $(VSCODE_DIR); \
	$(VSIX_PRETEST) && \
		$(VSIX_TEST_ENV) MOCHA_FILES="$$files" npx vscode-test --coverage \
		|| status=$$?; \
	rm -rf "$(abspath $(VSCODE_DIR))/bin" || true; \
	exit $$status
endef

_run-vsix-suite: $(if $(VSIX_PREBUILT),_stage-vsix-binary-only,_stage-vsix-binary)
	$(RUN_VSIX_SUITE)

# Compilation-only build-phase entry point. Test consumers always recompile
# their own extension/suite and rebuild binaries under [DIST-VSIX-REBUILD].
_build-vsix-suite:
	@echo "==> Compiling the VS Code suite once for every shard..."
	@cd $(VSCODE_DIR) && npm run prepare:tests

# The whole suite in one process, with coverage and the ratcheted gate. This is
# what `make test` runs locally. CI never runs it: unsharded it was the longest
# job in the pipeline by a wide margin, so the Ubuntu leg fans out over
# `_test-vsix-shard` instead and gates once over the union.
_test-vsix: _build-vsix
	@echo "==> Running VS Code extension tests..."
	@$(MAKE) _run-vsix-suite
	@$(CHECK_COV) vscode-extension --json $(VSCODE_DIR)/coverage/coverage-summary.json total.lines.pct

# [DIST-CI-VSIX-SHARDS] ONE coverage shard on ANY platform: a single chunk,
# instrumented, exporting lcov. The Ubuntu and Windows legs both run exactly
# this - there is no second, Windows-only recipe, because the two of them had
# already drifted apart once (one ran with coverage, one without).
#
# No gate here: no chunk can meet the line threshold alone, so the ratchet runs
# once over the union of BOTH platforms in the pipeline's final coverage job,
# exactly as the Rust shards do ([DIST-CI-RUST-SHARDS]).
#
# The tracefile is renamed per platform AND chunk because CI downloads every
# shard into one directory before merging, and `coverage/lcov.info` is the same
# path for all of them. Its `SF:` records are rewritten to repo-relative POSIX
# paths on the way out: c8 records absolute paths, and the same source file must
# key identically whether the shard that measured it ran on `C:\Code\SharpLsp`
# or `/home/runner/work/SharpLsp/SharpLsp` or the union counts it twice.
#
# Deliberately does NOT verify the VSIX payload. That is one production esbuild
# plus a `vsce ls` per shard for an answer that does not vary by shard, and
# worse: it leaves the PRODUCTION bundle in `dist/`, whose missing sourcemap
# would strip the end-to-end coverage this job exists to collect. The payload
# has its own job in both legs.
VSIX_PLATFORM = $(shell node -e "process.stdout.write(process.platform)")
VSIX_SHARD_LCOV = target/coverage-vsix-shard-$(VSIX_PLATFORM)-$(CHUNK).lcov

# The shared runner owns the full rebuild, so invoking it directly is safe too.
_test-vsix-shard:
	@test -n "$(CHUNK)" || { echo "ERROR: CHUNK is required (e.g. make _test-vsix-shard CHUNK=lsp)" >&2; exit 1; }
	@echo "==> Running VS Code coverage shard '$(VSIX_PLATFORM)/$(CHUNK)'..."
	@$(MAKE) _run-vsix-suite CHUNK=$(CHUNK)
	@mkdir -p target
	@node tools/coverage/relativize-lcov.mjs $(VSCODE_DIR)/coverage/lcov.info $(VSIX_SHARD_LCOV) .

# [DIST-CI-VSIX-SHARDS] Union-merge the shard tracefiles and enforce the same
# ratcheted threshold an unsharded run enforces. Every shard instruments the
# same bundle, so a file loaded by any shard carries its whole line set there
# (unexecuted lines as `DA:<line>,0`) and the union reproduces the line
# percentage of a single whole-suite run. Same merger the Rust gate uses.
_gate-vsix-coverage:
	@PERCENT="$$(node tools/coverage/merge-lcov.mjs target/coverage-vsix.lcov target/coverage-vsix-shard-*.lcov)" && \
		$(CHECK_COV) vscode-extension "$$PERCENT"


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
# Every chunk is instrumented; the combined coverage gate runs over the union.
VSIX_CHUNKS = node tools/vsix/vsix-test-chunks.mjs

_check-vsix-chunks:
	@$(VSIX_CHUNKS) check

# All VSIX consumers use the same fresh payload on local and CI machines.

# Pack the real VSIX and verify the payload actually made it in. `vsce ls` is the
# same file list `vsce package` writes, so this catches a .vscodeignore that
# swallowed the host, a sidecar or the debugger BEFORE 40 minutes of chunk time
# is spent proving it at the other end.
# Self-staging, because two different things delete `bin/` out from under it.
#
# `_build-vsix` ends with `rm -rf bin`, and a phony prerequisite is built at
# most ONCE per make invocation — so in `_test-vsix: ... _build-vsix
# _stage-vsix-binary _verify-vsix-payload` the staging prerequisite is already
# satisfied by the time make reaches it and never re-runs. Verification then
# reads the `bin/` that `_build-vsix` just removed and reports the host, both
# sidecars and the debug adapter missing. The `$(MAKE)` sub-invocation is what
# makes staging happen again; a plain prerequisite cannot.
#
# The production bundle is rebuilt for the same reason of accuracy: `vsce
# package` runs `vscode:prepublish` and so the production build, but `vsce ls`
# — which the verifier calls — does NOT. Without it the verifier judges
# whatever `dist/` happens to hold, and `npm run pretest` leaves the DEV
# bundle's sourcemap there, so the first chunk on a clean tree passes and every
# chunk after it fails on a file that would never have shipped.
_verify-vsix-payload: $(if $(VSIX_PREBUILT),_stage-vsix-binary-only,_stage-vsix-binary)
	@$(MAKE) _verify-staged-vsix-payload

_verify-staged-vsix-payload:
	@cd $(VSCODE_DIR) && npm run build:production --silent
	@cd $(VSCODE_DIR) && SHARPLSP_VSIX_PLATFORM=$(VSIX_PLAT) node ../../../tools/vsix/verify-vsix-payload.mjs

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

_test-dotnet: $(if $(VSIX_PREBUILT),,_build-dotnet)
	@echo "==> Running .NET sidecar tests..."
	@rm -rf target/coverage-dotnet
	$(DOTNET) test $(SIDECAR_SLN) --configuration $(DOTNET_CFG) \
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

# [DIST-CI-WIN-TRANSPORT] The win32 arm of the sidecar IPC transport. ONLY
# the classes whose behaviour is platform-dependent run here - named-pipe
# connection setup, and the real sidecar handshake over those pipes. Every
# other class in SharpLsp.Sidecar.Common.Tests is platform-agnostic and
# already ran ONCE in _test-dotnet on Ubuntu; running the whole project
# again on Windows executed ~12 files' worth of identical assertions a
# second time, which the pipeline's run-every-test-exactly-once rule
# forbids ([DIST-CI-LAYOUT]).
DOTNET_WIN_TRANSPORT_FILTER = FullyQualifiedName~SharpLsp.Sidecar.Common.Tests.IpcConnectionTests|FullyQualifiedName~SharpLsp.Sidecar.Common.Tests.SidecarHostEndToEndTests

_test-dotnet-win-transport:
	@echo "==> Running win32 named-pipe transport tests..."
	$(DOTNET) test $(SIDECAR_COMMON_TESTS) --configuration $(DOTNET_CFG) \
		--filter "$(DOTNET_WIN_TRANSPORT_FILTER)" \
		--blame-hang-timeout 2min --blame-hang-dump-type none

# Tests for the repo's own build tooling, as opposed to the product. Today that
# is how the netcoredbg debug adapter is obtained ([DIST-DEBUGGER-BUNDLE]) - the
# supply-chain path that every VSIX and every release depends on - and the local
# install loop ([DIST-VSIX-DEV-INSTALL]), whose whole contract is an ordering
# that nothing else in the suite exercises. Node's built-in runner, so this
# needs no dependency of its own.
_test-tooling:
	@echo "==> Running repo tooling tests..."
	node --test tools/netcoredbg/custody.test.mjs tools/make/reinstall-loop.test.mjs tools/make/vsix-rebuild.test.mjs tools/vsix/rebuild-contract.test.mjs tools/audit/dotnet-vulnerable.test.mjs

_website-build:
	@echo "==> Building website..."
	npm run build --prefix src/website

_website-dev:
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

_lint-vsix: _check-vsix-chunks _check-sdk-pin
	node --test tools/ci/security-gates.test.mjs tools/ci/changed-files.test.mjs
	npm run lint:eslint --prefix $(VSCODE_DIR)
	npm run typecheck --prefix $(VSCODE_DIR)

# global.json and every workflow's dotnet-version MUST agree ([DIST-RUNTIME-ACQUIRE]).
# CI installs the pinned SDK onto $$PATH, so a mismatch is invisible in CI and
# breaks every build on machines that lack the pinned band.
_check-sdk-pin:
	node tools/ci/check-sdk-pin.mjs

# Dash-form MSBuild switches only: Git Bash (MSYS) mangles slash-form switches
# like `/p:...` on Windows (strips the `/`, MSBuild then reads it as a project
# path and fails with MSB1008). Dash-form behaves identically on all platforms.
_lint-dotnet:
	$(DOTNET) build $(SIDECAR_SLN) --configuration $(DOTNET_CFG) -warnaserror \
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
	$(DOTNET) csharpier format $(dir $(SIDECAR_SLN))
	$(DOTNET) format $(SIDECAR_SLN)

# ── Screenshots ───────────────────────────────────────────────────

_screenshots: _build-rust _build-dotnet _build-vsix
	@echo "==> Capturing all website _screenshots from real VS Code..."
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
#
# The Rider plugin's pluginVersion belongs here too: buildPlugin names the zip
# from it and JetBrains keys plugin updates on it, so an unstamped one shipped
# 0.1.0 from every tag. [DIST-VERSION-INVARIANT]

_stamp-version:
	@echo "==> Stamping version $(VERSION) into all manifests..."
	sed -i.bak 's/^version = "[^"]*"/version = "$(VERSION)"/' Cargo.toml
	sed -i.bak 's/^version = "[^"]*"/version = "$(VERSION)"/' $(ZED_DIR)/Cargo.toml
	sed -i.bak 's/^version = "[^"]*"/version = "$(VERSION)"/' $(ZED_DIR)/extension.toml
	sed -i.bak 's/^pluginVersion = .*/pluginVersion = $(VERSION)/' $(RIDER_DIR)/gradle.properties
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
	@rm -f Cargo.toml.bak $(ZED_DIR)/Cargo.toml.bak \
		$(ZED_DIR)/extension.toml.bak $(RIDER_DIR)/gradle.properties.bak
	@echo "==> Version $(VERSION) stamped."

# ── Package VSIX (per platform) ───────────────────────────────────
# [BINARY-RELEASE] Builds the Rust binary for the given target triple, stages it, and packages
# a platform-specific VSIX into dist/.
#
# Usage:
#   make _package-vsix-darwin-arm64                  (VERSION defaults to 0.0.0)
#   make _package-vsix-darwin-arm64 VERSION=0.3.0
#   make _package-vsix-darwin-arm64 RUST_TARGET=aarch64-apple-darwin VERSION=0.3.0
#
# VERSION is optional (defaults to the 0.0.0 placeholder) and is stamped into
# all manifests before building.
# RUST_TARGET defaults to the canonical triple for each platform.

_package-vsix-linux-x64:   RUST_TARGET ?= x86_64-unknown-linux-gnu
_package-vsix-linux-arm64:  RUST_TARGET ?= aarch64-unknown-linux-gnu
_package-vsix-darwin-arm64: RUST_TARGET ?= aarch64-apple-darwin
_package-vsix-darwin-x64:   RUST_TARGET ?= x86_64-apple-darwin
_package-vsix-win32-x64:    RUST_TARGET ?= x86_64-pc-windows-msvc
_package-vsix-win32-arm64:  RUST_TARGET ?= aarch64-pc-windows-msvc

PACKAGE_VSIX_TARGETS = \
	_package-vsix-linux-x64 _package-vsix-linux-arm64 \
	_package-vsix-darwin-arm64 _package-vsix-darwin-x64 \
	_package-vsix-win32-x64 _package-vsix-win32-arm64

# VERSION is optional and scoped to packaging ONLY. As a target-specific
# variable it also reaches the _stamp-version prerequisite and the recursive
# _build-dotnet / _package-vsix sub-makes, so the whole package build shares one
# version. When the caller omits it, the 0.0.0 placeholder is stamped (valid
# SemVer, no '-', so it never trips the --pre-release path). It is deliberately
# NOT a global default: standalone build/test invocations leave VERSION empty so
# each project keeps its committed baseline version and the sidecar `--version`
# contract (test-dotnet) holds. A release passes VERSION=x.y.z, overriding this.
$(PACKAGE_VSIX_TARGETS): VERSION ?= 0.0.0

# [DIST-VSIX-CONTENTS] The platform is stripped off the FULL target name,
# leading underscore included. `package-vsix-` matches from index 1 of
# `_package-vsix-win32-x64` and leaves the `_` behind, so VSIX_PLAT became
# `_win32-x64` and flowed into vsce's `--target`, the .vsix filename, the bin/
# staging directory and fetch-netcoredbg.sh - on all six platforms. The targets
# were renamed when tools/make/main.mk was consolidated; release.yml:148 is the
# only caller in the repo and no PR pipeline runs it, so it would have failed
# first on a tag.
$(PACKAGE_VSIX_TARGETS): _stamp-version
	$(eval VSIX_PLAT := $(subst _package-vsix-,,$@))
	$(eval EXE       := $(if $(filter win32-%,$(VSIX_PLAT)),.exe,))
	$(MAKE) _package-vsix VSIX_PLAT=$(VSIX_PLAT) RUST_TARGET=$(RUST_TARGET) EXE=$(EXE) VERSION=$(VERSION)
	$(MAKE) _package-archive VSIX_PLAT=$(VSIX_PLAT) RUST_TARGET=$(RUST_TARGET) EXE=$(EXE)

_package-vsix: PROFILE = release
_package-vsix: _stage-vsix-binary
	@echo "==> Packaging VSIX for $(VSIX_PLAT)..."
	npm run build --prefix $(VSCODE_DIR)
	@$(MAKE) _verify-staged-vsix-payload
	mkdir -p dist
	# vsce/ovsx refuse to PUBLISH with --pre-release unless the VSIX was also
	# PACKAGED with --pre-release (it sets preRelease=true in the embedded
	# manifest). A hyphenated SemVer VERSION (e.g. 0.2.0-rc.1) is a prerelease.
	cd $(VSCODE_DIR) && SHARPLSP_VSIX_PLATFORM=$(VSIX_PLAT) npx @vscode/vsce package --no-dependencies \
		$(if $(findstring -,$(VERSION)),--pre-release,) \
		--target $(VSIX_PLAT) \
		-o ../../../dist/sharplsp-$(VSIX_PLAT).vsix
	rm -rf $(VSCODE_DIR)/bin
	@echo "==> dist/sharplsp-$(VSIX_PLAT).vsix ready."

# ── Package standalone server archive (per platform) ─────────────
# [DIST-ARCHIVE] The editor-agnostic distribution: the Rust host plus both
# sidecars, with no VS Code extension wrapped around them. Rider, Zed, Neovim,
# Helix, Emacs and the Homebrew/Scoop formulas ([DIST-PATH-INSTALL]) all consume
# this, not the VSIX.
#
# Layout is dictated by the host's OWN sidecar resolution — `installed_sidecar_exe`
# in src/sharplsp/src/sidecar/manager.rs, layout 1 (`<exe_dir>/<subdir>/<name>`).
# Unpack anywhere and run `sharplsp`; the sidecars resolve with no env vars, no
# PATH entries and no configuration:
#
#   sharplsp-<platform>/
#     sharplsp[.exe]
#     sidecar-csharp/SharpLsp.Sidecar.CSharp[.exe]   + managed assemblies
#     sidecar-fsharp/SharpLsp.Sidecar.FSharp[.exe]   + managed assemblies
#
# Sidecar executables keep their published assembly names here. The VSIX renames
# them to sharplsp-sidecar-* because the extension hands the host explicit paths
# via SHARPLSP_*_SIDECAR_PATH; this archive has no such helper, so the names must
# be the ones the host looks for on its own.
#
# Packages what is already on disk — the package-vsix-<platform> recipe builds
# Rust and the sidecars once and drives both packagers. ARCHIVE_LSP defaults to
# the cross-compiled binary a release build produces; CI's Ubuntu build leg has
# only the host-triple build at target/release/ and overrides it.
ARCHIVE_LSP ?= target/$(RUST_TARGET)/release/sharplsp$(EXE)

_package-archive:
	@echo "==> Packaging standalone archive for $(VSIX_PLAT)..."
	rm -rf $(ARCHIVE_STAGE)
	mkdir -p $(ARCHIVE_STAGE)/sharplsp-$(VSIX_PLAT)/sidecar-csharp \
		$(ARCHIVE_STAGE)/sharplsp-$(VSIX_PLAT)/sidecar-fsharp
	cp $(ARCHIVE_LSP) $(ARCHIVE_STAGE)/sharplsp-$(VSIX_PLAT)/sharplsp$(EXE)
	cp -r $(SIDECAR_CS_OUT)/. $(ARCHIVE_STAGE)/sharplsp-$(VSIX_PLAT)/sidecar-csharp/
	cp -r $(SIDECAR_FS_OUT)/. $(ARCHIVE_STAGE)/sharplsp-$(VSIX_PLAT)/sidecar-fsharp/
	chmod +x $(ARCHIVE_STAGE)/sharplsp-$(VSIX_PLAT)/sharplsp$(EXE) \
		$(ARCHIVE_STAGE)/sharplsp-$(VSIX_PLAT)/sidecar-csharp/SharpLsp.Sidecar.CSharp$(EXE) \
		$(ARCHIVE_STAGE)/sharplsp-$(VSIX_PLAT)/sidecar-fsharp/SharpLsp.Sidecar.FSharp$(EXE) 2>/dev/null || true
	@sh tools/packaging/archive.sh $(ARCHIVE_STAGE) sharplsp-$(VSIX_PLAT) \
		$(DIST_DIR)/sharplsp-$(VSIX_PLAT)$(if $(filter win32-%,$(VSIX_PLAT)),.zip,.tar.gz)
	rm -rf $(ARCHIVE_STAGE)

# ── Marketplace publish helpers ──────────────────────────────────
# Downloads all VSIX assets from the latest GitHub release and prints the
# vsce publish command for each one. Does NOT publish anything.
#
# Usage:
#   make _print-publish-commands

_print-publish-commands:
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

# ── Install / reinstall the VSIX ──────────────────────────────────
# [DIST-VSIX-DEV-INSTALL] The local loop: kill stale servers, clean every
# artifact, rebuild the Rust host + both sidecars + the extension for the host
# platform, drop the installed extension, install the fresh VSIX.

# The extension identifier, read from the manifest that defines it. Hardcoding it
# is how the previous uninstall target came to name an extension id that had not
# existed for months, silently uninstalling nothing. [DIST-VSIX-DEV-INSTALL]
EXTENSION_ID = $(shell node -e "const p=require('./$(VSCODE_DIR)/package.json');process.stdout.write(p.publisher+'.'+p.name)")

# Resolve the VS Code CLI into $$code_cli, or fail loudly. Windows runs these
# recipes under Git Bash, where `code` is a .cmd shim that may not be on PATH, so
# probe the default per-user and machine-wide install locations too. Override the
# whole probe with CODE=/path/to/code. [DIST-VSIX-DEV-INSTALL]
RESOLVE_CODE = \
	code_cli="$(CODE)"; \
	if [ -z "$$code_cli" ]; then \
		for candidate in code code.cmd \
			"$$LOCALAPPDATA/Programs/Microsoft VS Code/bin/code.cmd" \
			"/c/Program Files/Microsoft VS Code/bin/code.cmd" \
			"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do \
			if command -v "$$candidate" >/dev/null 2>&1; then code_cli="$$candidate"; break; fi; \
		done; \
	fi; \
	if [ -z "$$code_cli" ]; then \
		echo "ERROR: no VS Code CLI found. Enable it from VS Code (Command Palette:" >&2; \
		echo "       'Shell Command: Install code command in PATH'), or pass CODE=/path/to/code." >&2; \
		exit 1; \
	fi

# Ordered sub-makes, NOT prerequisites: under `make -j` prerequisites run
# concurrently and `clean` would race the build it feeds. [DIST-VSIX-DEV-INSTALL]
#
# The extension comes off first, so a failed build leaves no stale copy of
# SharpLsp loaded in VS Code pretending to be the change under test.
# `_build-vsix` pulls in `_build-rust` and `_build-dotnet`, so the Rust host and
# both sidecar binaries are rebuilt here, not reused from the cleaned tree.
reinstall-vsix:
	@echo "==> Uninstall, full clean, rebuild and reinstall for $(HOST_PLATFORM)..."
	$(MAKE) uninstall-vsix
	$(MAKE) _kill
	$(MAKE) _clean-artifacts
	$(MAKE) _build-vsix
	$(MAKE) install-vsix

install-vsix:
	@test -f $(DEV_VSIX) || { \
		echo "ERROR: $(DEV_VSIX) not found. Run 'make reinstall-vsix' to build and install it." >&2; \
		exit 1; \
	}
	@echo "==> Installing $(DEV_VSIX)..."
	@$(RESOLVE_CODE); \
		"$$code_cli" --install-extension "$(DEV_VSIX)" --force
	@echo "==> $(EXTENSION_ID) installed. Reload VS Code to pick it up."

# Uninstalling what is not installed is a success, not a failure: the reinstall
# loop runs this on a clean machine too.
uninstall-vsix:
	@echo "==> Uninstalling $(EXTENSION_ID)..."
	@$(RESOLVE_CODE); \
		"$$code_cli" --uninstall-extension "$(EXTENSION_ID)" || true

# ── Install (private) ─────────────────────────────────────────────

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

clean: _clean-rider _clean-artifacts
	@echo "==> Clean."

# The VSIX rebuild loop's own clean: Rust host, sidecars, VS Code and dist
# output. `reinstall-vsix` calls this directly, never the full `clean`, so
# uninstalling and rebuilding the extension never shells out to Gradle for a
# Rider plugin it does not touch ([DIST-VSIX-REBUILD]).
_clean-artifacts:
	@echo "==> Cleaning build artifacts..."
	cargo clean
	cargo clean --manifest-path $(ZED_DIR)/Cargo.toml
	node tools/vsix/clean-sidecar-output.mjs
	rm -rf $(SIDECAR_CS_OUT) $(SIDECAR_FS_OUT)
	rm -rf $(VSCODE_DIR)/bin $(VSCODE_DIR)/dist $(VSCODE_DIR)/out
	rm -rf $(ZED_PKG_DIR) $(DIST_DIR)
	rm -f $(DEV_VSIX) $(ZED_PKG_TAR)

_clean-rider:
	@$(RIDER_GRADLE) clean || true
	rm -rf $(RIDER_DIR)/build $(RIDER_DIR)/.gradle $(RIDER_ZIP)

# ── Setup ─────────────────────────────────────────────────────────

setup:
	@echo "==> Setting up development environment..."
	rustup component add clippy rustfmt llvm-tools-preview
	cargo install cargo-llvm-cov || true
	cargo install cargo-audit --locked || true
	npm install --prefix $(VSCODE_DIR)
	$(DOTNET) restore $(SIDECAR_SLN)
	$(DOTNET) tool restore
	@echo "==> Setup complete. Run 'make ci' to validate."

# ── .NET 10 SDK + Runtime install/uninstall ───────────────────────

DOTNET_INSTALL_SCRIPT = $(HOME)/.dotnet-install/dotnet-install.sh

ifeq ($(DETECTED_OS),windows)

install-dotnet-10:
	@echo "==> Installing .NET 10 SDK + runtime for the current Windows user..."
	powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/dotnet-10.ps1 -Action Install

_uninstall-dotnet-10:
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
	@$(DOTNET) --list-sdks | grep '^10\.' || true
	@$(DOTNET) --list-runtimes | grep '^Microsoft.*10\.' || true

_uninstall-dotnet-10:
	@echo "==> Uninstalling .NET 10 SDK + runtime from /usr/local/share/dotnet..."
	@for sdk in $$($(DOTNET) --list-sdks 2>/dev/null | awk '/^10\./ {print $$1}'); do \
		echo "  Removing SDK $$sdk..."; \
		sudo rm -rf "/usr/local/share/dotnet/sdk/$$sdk"; \
	done
	@for rt in $$($(DOTNET) --list-runtimes 2>/dev/null | awk '/10\./ {print $$2}'); do \
		echo "  Removing runtime $$rt..."; \
		sudo rm -rf "/usr/local/share/dotnet/shared/Microsoft.NETCore.App/$$rt"; \
		sudo rm -rf "/usr/local/share/dotnet/shared/Microsoft.AspNetCore.App/$$rt"; \
		sudo rm -rf "/usr/local/share/dotnet/host/fxr/$$rt"; \
	done
	@echo "==> .NET 10 removed. Remaining:"
	@$(DOTNET) --list-sdks || true
	@$(DOTNET) --list-runtimes || true

endif
