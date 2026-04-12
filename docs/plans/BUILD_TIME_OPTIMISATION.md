# Plan: CI Build Time Optimization

## Context

The CI `Test` job is hitting the 20-minute timeout and getting cancelled. From the logs of run #23580577212, here's the actual timing breakdown:

### Current Timeline (Test job starts at 07:09:52)

| Phase | Start | End | Duration | Details |
|-------|-------|-----|----------|---------|
| Build C# sidecar | 07:09:52 | 07:10:13 | **21s** | `dotnet publish` (restore + build) |
| Rust tests (cargo llvm-cov) | 07:10:14 | 07:19:34 | **9m20s** | 176 tests, finished in **494.93s** (3 failed) |
| Zed WASM build (release) | 07:19:34 | 07:20:16 | **42s** | `cargo build --release --target wasm32-wasip1` |
| Zed tests (debug build) | 07:20:16 | 07:20:51 | **35s** | Rebuilds from scratch in debug mode, 15 tests run in 0.00s |
| .NET sidecar tests | 07:20:51 | 07:21:29 | **38s** | 80 tests total (24+29+27), all pass |
| VS Code extension tests | 07:21:34 | 07:29:23 | **7m49s** | 23 failures, then cancelled at 20min |
| **Total** | | | **~19m30s** | Hits 20min timeout |

### Root Causes (ordered by impact)

1. **Rust E2E tests: 9m20s** - 176 tests running sequentially with real sidecar processes, each spawning .NET processes and doing IPC over sockets
2. **VS Code extension tests: 7m49s** - 10+ test suites each independently start the LSP server (30s timeout per suite setup), total ~7m49s
3. **Zed double-build: 77s wasted** - Builds release WASM first (`cargo build --release`), then rebuilds entirely in debug for tests (`cargo test`)
4. **Sequential execution** - Everything runs sequentially within the Test job: Rust tests, then Zed, then .NET, then VS Code

---

## Plan

### 1. Split the monolithic Test job into parallel jobs

**File:** `.github/workflows/ci.yml`

Split the single `Test` job (20min timeout) into 3-4 independent parallel jobs:

```
test-rust:     Rust LSP tests + coverage        (~9-10min)
test-dotnet:   .NET sidecar tests + coverage     (~1min)
test-zed:      Zed extension build + tests       (~1min)
test-vsix:     VS Code extension tests + coverage (~8min)
```

Each job runs independently on its own runner. Total wall-clock time drops from ~20min to ~10min (limited by the slowest job: Rust tests).

**Implementation:**
- Create 4 separate jobs: `test-rust`, `test-dotnet`, `test-zed`, `test-vsix`
- Each job has its own setup steps (checkout, toolchain, cache)
- `test-rust` needs: dotnet (for sidecar build), rust toolchain, cargo-llvm-cov
- `test-dotnet` needs: dotnet only
- `test-zed` needs: rust toolchain only
- `test-vsix` needs: rust toolchain, dotnet, node, xvfb
- Coverage ratcheting: Move threshold commit to a separate `coverage` job that `needs: [test-rust, test-dotnet, test-vsix]` and only runs if all pass
- Each test job uploads coverage artifacts; the coverage job downloads and commits

### 2. Fix the Zed double-build waste

**File:** `Makefile`

The `test-zed` target depends on `build-zed` which does `cargo build --release`. Then `cargo test` rebuilds everything in debug mode. 77 seconds wasted.

**Fix:** Change `test-zed` to not depend on `build-zed` for CI, or change the build to use debug mode for testing:
```makefile
test-zed:
	@echo "==> Running Zed extension tests..."
	cargo test --manifest-path $(ZED_DIR)/Cargo.toml
```

Remove the `build-zed` dependency from `test-zed`. The WASM release build is only needed for packaging, not testing. The tests compile their own debug binary anyway.

### 3. Deduplicate Rust E2E tests that overlap with sidecar tests

**Files:**
- `tests/lsp_e2e.rs` (184 tests, 7905 lines)
- `sidecars/Forge.Sidecar.CSharp.Tests/SidecarEndToEndTests.cs` (19 tests)
- `sidecars/Forge.Sidecar.FSharp.Tests/SidecarEndToEndTests.fs` (22 tests)

Many Rust E2E tests duplicate what [text](vscode-webview://0jqj3h8eg8r1kfkms2os8gt7bh0tn5h3gs9eva507nuvj83299j9/index.html?id%3D52cf95f5-e79d-4895-9c5e-61e3156e5657%26parentId%3D10%26origin%3D8a554ffb-5562-4d53-9c34-30dd05d7771b%26swVersion%3D4%26extensionId%3DAnthropic.claude-code%26platform%3Delectron%26vscode-resource-base-authority%3Dvscode-resource.vscode-cdn.net%26parentOrigin%3Dvscode-file%3A%2F%2Fvscode-app%26session%3Db9109bac-fa3a-45ce-a231-14fd7b112bb0)the .NET sidecar E2E tests already cover (hover, definition, references, completion, etc.). The Rust tests go through the full LSP stack while sidecar tests go through IPC directly.

**Analysis needed:** Identify which Rust E2E tests are pure duplicates of sidecar tests vs. which test Rust-specific routing logic. Tests that only verify "sidecar returns correct result through LSP" are redundant when sidecar E2E tests already verify the sidecar directly.

**Approach:** Remove Rust E2E tests that are exact functional duplicates of sidecar tests, keeping only:
- Tests that verify Rust-only features (tree-sitter, salsa cache, VFS)
- Tests that verify request routing logic
- Tests that verify the LSP wire protocol
- One smoke test per feature category (hover, definition, etc.) to verify end-to-end integration

### 4. Set per-job timeouts appropriately

**File:** `.github/workflows/ci.yml`

Once split into parallel jobs:
- `test-rust`: 12min timeout
- `test-dotnet`: 5min timeout
- `test-zed`: 5min timeout
- `test-vsix`: 10min timeout

---

## Files to Modify

1. `.github/workflows/ci.yml` - Split Test job into parallel jobs
2. `Makefile` - Remove `build-zed` dependency from `test-zed`, add coverage artifact targets
3. `tests/lsp_e2e.rs` - Remove duplicate tests (Phase 2, requires careful analysis)

## Verification

1. Push the CI changes and verify all 4 parallel test jobs pass
2. Verify total wall-clock time drops from 20min to ~10min
3. Verify coverage thresholds still ratchet correctly
4. Verify no test coverage is lost (thresholds should not drop)
