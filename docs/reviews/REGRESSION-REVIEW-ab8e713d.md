# Static Regression Review — `ab8e713d..origin/chore/test-host-no-ai-actions`

**Reviewed target:** `e4e7963398088a8ee7726c675b24a2da2f762c38`  
**Base:** `ab8e713d0597843bf2fbc3151701a38e4aba9989`  
**Scope:** the complete Git diff: 979 files, 69,503 insertions and 8,178 deletions at the reviewed tip. This was a static, read-only review; no build or test execution was used.

## Findings

### 1. High — the dependency audit silently drops lspkit's required Rust and npm inventories

**Location:** `Makefile:466-467`; contract at `docs/specs/DISTRIBUTION-SPEC.md:919-921` (`[DIST-CI-AUDIT]`)

**Evidence:** `AUDIT_CARGO_LOCKS` now contains only `Cargo.lock` and the Zed lockfile. `AUDIT_NPM_DIRS` now contains only VS Code, the website and video tooling. The diff removes `lspkit/Cargo.lock`, `lspkit/packages/lspkit-debug` and `lspkit/packages/lsp-profiler-ui` from these inventories. Yet the unchanged spec explicitly requires the shared lspkit Cargo lockfile and both lspkit npm lockfiles to be scanned. The new `_fetch-lspkit` source tree makes those files available, but neither audit loop points into it.

**Why this is a regression:** a required security gate now examines fewer dependency inventories than it did at the base. Vulnerabilities unique to lspkit's own development/debug/UI dependency graphs can be missed while `make audit` still prints its clean-success message. Scanning SharpLsp's root lockfiles covers the packages SharpLsp directly resolves; it does not restore the removed coverage of lspkit's own lockfiles.

### 2. Medium — the contributor film still checks out the deleted `lspkit` submodule

**Location:** `src/website/tools/video/kit/set.mjs:72` (consumer at `src/website/tools/video/films/contributing/film.mjs:63-65`)

**Evidence:** `REPO.stage` runs:

```js
unpackHead(path.join(repoRoot, 'lspkit'), path.join(workspace, 'lspkit'));
```

`unpackHead` executes `git -C <repo> archive HEAD` and throws on a non-zero result. At the target, `.gitmodules` and the `lspkit` gitlink are deleted, so `<repoRoot>/lspkit` no longer exists. The `contributing` film selects `REPO` as its demo, making this path live rather than dead helper code.

**Why this is a regression:** `node src/website/tools/video/film.mjs contributing` can no longer stage its workspace and fails before recording. This is a direct stale path left by the submodule removal.

### 3. Medium — `make _screenshots` now runs the suite without taking any screenshots

**Location:** `Makefile:902-920`; unused capture helper at `src/editors/vscode/src/test/suite/test-helpers.ts:543-550`

**Evidence:** the target still starts `screenshot-watcher.mjs`, sets `SHARPLSP_SCREENSHOTS=1`, runs the VS Code tests and reports the test status as the screenshot target's result. The diff deletes the `takeScreenshot(...)` calls from the diagnostics, extension, hover, LSP integration, semantic integration and NuGet suites. At the target, a repository-wide search for `takeScreenshot(` finds only the helper's own declaration and watcher documentation—no test call sites remain.

**Why this is a regression:** the target can complete successfully while producing zero PNGs and leaving every existing capture stale. The new film-produced WebP stills do not repair this Make target or provide a completion check for the legacy screenshots that `src/website/tests/screenshots.spec.js` still renders. This is silent deletion of the target's advertised behavior, not merely removal of redundant test interactions.

### 4. Medium — the shipped profiler engine is built from an unverified, mutable tag archive

**Location:** `Makefile:96-97`, `Makefile:269`, `Makefile:271-276`

**Evidence:** `_fetch-lspkit` pipes `https://github.com/Nimblesite/lspkit/archive/refs/tags/v0.4.0.tar.gz` directly from `curl` into `tar`. There is no commit assertion, SHA-256 check, signature check, or expected-file verification. `_build-dotnet` then publishes the engine from that tree. At the base, `lspkit` was a gitlink pinned to exact commit `e6e417275a76568d559ef26f9f68752f7a0f4454`.

**Why this is a regression:** the bytes compiled into the shipped engine are no longer bound to an immutable reviewed revision. A moved tag, altered upstream release or incomplete extraction can change or corrupt build inputs without any SharpLsp diff, and an already-created `target/lspkit-0.4.0` directory suppresses the fetch rule on later invocations. The crates and npm package have registry integrity/checksums; the source-built engine has no equivalent guard here.

### 5. Low — the profiler specification still names the removed submodule fixture path

**Location:** `docs/specs/PROFILER-SPEC.md:60`; actual resolver at `src/editors/vscode/src/test/suite/profiler-fixtures.ts:10-16`

**Evidence:** the spec says the F# target is `lspkit/dotnet/fixtures/HotLeakAppFs`. That path disappeared with the gitlink. The real suite now resolves `$(LSPKIT_DIR)/dotnet/fixtures`, where `LSPKIT_DIR` is `target/lspkit-0.4.0`.

**Why this is a regression:** the source-of-truth test documentation points contributors and tooling at a nonexistent fixture location and disagrees with the implementation. It should name the release-source layout or the `LSPKIT_DIR` indirection, not the deleted submodule path.

## Targeted checks with no additional finding

- **Profiler/e2e retention:** all 31 profiler/memory `*.test.ts` suites present at the base remain at the target; none was deleted. No `test-chunks.json` file entry was removed. The profiler and memory glob entries remain in force.
- **Webview suite replacement:** the 11 local tests deleted from `profiler-webviews.test.ts` were replaced by the 0.4 shared contract import, whose four modules register 23 tests and retain the CSP, escaping, theme, artifact, empty-state and singleton-handler assertions.
- **Async UI 0.4 migration:** remaining `buildFlamegraphHtml`, profile/memory/leak decoration, `removeTestDir`, profiler-suite teardown and CPU-contract call sites are awaited or registered synchronously as appropriate. `buildMemoryDashboardHtml` remains synchronous in 0.4, so its unawaited call is correct.
- **Paths:** no remaining broken Rust `#[path]` target was found. `LSPKIT_DIR` is exported by the Makefile and the profiler fixture resolver uses it correctly. The two stale paths are findings 2 and 5.
- **Tests/assertions:** test-count comparison found no other reduced suite. Removed configuration tests were consolidated with equivalent cases; the Test Explorer coverage assertion changed to the new one-owner build-graph contract with additional assertions rather than simple weakening.
- **Dependencies:** no version downgrade was found in the compared Cargo/npm lockfiles or direct dependency changes. All four lspkit Rust crates and the npm UI package resolve to 0.4.0. Coverage and duplication thresholds were tightened, not lowered.
- **Spec IDs:** no newly dangling spec-ID citations were found, including the newly cited lspkit pull/profiler IDs. No spec-definition heading was removed.
- **CI execution:** apart from intentional submodule checkout and profiler-UI generation removal, no workflow step silently disappeared. New chunk matrices continue to derive from `test-chunks.json`; the source-builder and Windows F# test legs were added.
- **Merge damage:** no conflict markers were found. `git diff --check` reported only blank lines at EOF in two F# test files and three VTT files, not lost-hunk evidence.
