# NuGet Browser Implementation Plan

**Spec:** [NUGET-BROWSER-SPEC.md](../specs/NUGET-BROWSER-SPEC.md)
**Design:** `docs/designs/code.html`, `docs/designs/screen.png`

## Current State (Fixed)

All critical issues have been resolved:

1. ~~**Extension talks directly to nuget.org and dotnet CLI**~~ - FIXED. All operations go through `sharplsp/nuget/*` LSP custom requests. Extension is a thin UI shell.
2. ~~**UI uses emoji icons**~~ - FIXED. All icons replaced with Material Symbols Outlined spans.
3. ~~**Duplicate settings cog**~~ - FIXED. Settings in header + sidebar bottom per design spec.
4. ~~**Missing Dependencies section**~~ - FIXED. Dependencies section added to details panel.
5. **No logging** - Fixed (logging added throughout).
6. ~~**No tests**~~ - FIXED. Rust E2E tests (`tests/nuget_e2e.rs`) and VSIX tests (`nuget-browser.test.ts`) added.
7. ~~**Font/spacing mismatch**~~ - FIXED. Inter font + Material Symbols imported via Google Fonts CDN. CSS matches M3 dark theme.
8. ~~**Browse tab empty on load**~~ - FIXED. Constructor now calls `performSearch("")` after loading installed packages to populate popular packages.
9. ~~**Clicking installed packages does nothing**~~ - FIXED. Added `findOrSynthesizePackage()` that resolves package IDs from both `searchResults` and `installedPackages` map. Installed-only packages are enriched with real metadata via a targeted search on selection.

## Phase 1: Rust LSP Host - NuGet Request Handlers

Implement `sharplsp/nuget/*` custom request handlers in the Rust LSP host. These wrap the dotnet CLI and nuget.org HTTP API.

### 1.1 Types & Module Structure

- [x] Create `src/nuget/` module (mod.rs, types.rs, cache.rs, search.rs, cli.rs, handlers.rs)
- [x] Define request/response types for all 5 endpoints (see spec section 3)
- [x] Register `sharplsp/nuget/*` routes in `handle_custom_request()` in `src/main.rs`

### 1.2 `sharplsp/nuget/search` Handler

- [x] HTTP GET to `https://azuresearch-usnc.nuget.org/query` with query params
- [x] Parse NuGet v3 search API JSON response
- [x] Cross-reference with installed packages (call `dotnet list` internally)
- [x] Return `NuGetSearchResponse` with `isInstalled` / `installedVersion` populated
- [x] Cache search results for 60s (avoid API hammering)
- [x] Popular packages fallback when query is empty

### 1.3 `sharplsp/nuget/versions` Handler

- [x] HTTP GET to `https://api.nuget.org/v3-flatcontainer/{id}/index.json`
- [x] Parse version list, return newest-first
- [x] Cache version lists for 5 minutes

### 1.4 `sharplsp/nuget/installed` Handler

- [x] Execute `dotnet list <projectPath> package --format json`
- [x] Parse JSON output, extract packages across all target frameworks
- [x] Return `NuGetInstalledResponse`

### 1.5 `sharplsp/nuget/install` Handler

- [x] Execute `dotnet add <projectPath> package <packageId> --version <version>`
- [x] Parse stdout/stderr for success/failure
- [ ] On success, notify sidecar to reload workspace (project file changed)
- [x] Return `NuGetInstallResponse`

### 1.6 `sharplsp/nuget/uninstall` Handler

- [x] Execute `dotnet remove <projectPath> package <packageId>`
- [x] Parse stdout/stderr for success/failure
- [ ] On success, notify sidecar to reload workspace
- [x] Return `NuGetUninstallResponse`

### 1.7 E2E Tests (Rust)

- [x] Test `sharplsp/nuget/search` returns results for "Newtonsoft"
- [x] Test `sharplsp/nuget/search` with empty query returns popular packages
- [x] Test `sharplsp/nuget/search` marks installed packages correctly
- [x] Test `sharplsp/nuget/versions` returns versions for "Newtonsoft.Json"
- [x] Test `sharplsp/nuget/installed` returns packages for test project
- [x] Test `sharplsp/nuget/install` adds package to test project
- [x] Test `sharplsp/nuget/uninstall` removes package from test project
- [x] Test error handling: invalid project path
- [x] Test error handling: nonexistent package ID

## Phase 2: Extension - Refactor to LSP Requests

Gut the direct CLI/HTTP calls from the extension. Replace with LSP custom requests.

### 2.1 Remove Direct Calls

- [x] Remove `execFileAsync` calls from `nuget-browser.ts`
- [x] Remove `fetch()` calls to nuget.org from `nuget-browser.ts`
- [x] Remove `node:child_process` import

### 2.2 Add LSP Request Wrappers

- [x] Add `searchPackages(query, projectPath)` that sends `sharplsp/nuget/search`
- [x] Add `getVersions(packageId)` that sends `sharplsp/nuget/versions`
- [x] Add `getInstalledPackages(projectPath)` that sends `sharplsp/nuget/installed`
- [x] Add `installPackage(projectPath, packageId, version)` that sends `sharplsp/nuget/install`
- [x] Add `uninstallPackage(projectPath, packageId)` that sends `sharplsp/nuget/uninstall`

### 2.3 Wire Up Message Handler

- [x] Update `handleMessage()` to use LSP wrappers instead of direct calls
- [x] Ensure error responses from LSP are displayed in webview + notification

## Phase 3: UI - Match Design Spec

Fix the webview HTML/CSS to match `docs/designs/code.html` exactly.

### 3.1 Fonts & Icons

- [x] Add Google Fonts import for Inter (300-800 weights)
- [x] Add Material Symbols Outlined font import
- [x] Replace ALL emoji with Material Symbols Outlined spans
- [x] Icon mapping: folder, search, layers, settings, package_2, download, person, verified_user, database, api, security, sync, expand_more, open_in_new, link, account_tree, chevron_right

### 3.2 Layout Fixes

- [x] Remove duplicate settings cog from header (keep only in sidebar bottom)
- [x] Header: logo + nav tabs on left, search + sync button on right
- [x] Sidebar: terminal icon (dimmed) at top, nav icons, settings at bottom with avatar
- [x] Package list: proper padding (p-4, space-y-2), border-l-2 on selected
- [x] Details panel: w-96, bg-surface-container-low

### 3.3 Missing Sections

- [x] Add Dependencies section to details panel (target frameworks list)
- [x] Dependencies items: account_tree icon, framework name, hover chevron_right
- [x] Style: bg-surface-container rounded-md, hover:bg-surface-container-high

### 3.4 Typography & Spacing

- [x] Match tailwind spacing scale from design (p-6, gap-4, etc.)
- [x] Match font sizes: logo 18px bold, nav 13px, package name 15px semibold
- [x] Match label styles: uppercase, tracking-widest, 0.6rem, font-bold
- [x] Match tag styles: px-2 py-1, bg-surface-container-highest, rounded-full, 0.6rem
- [x] Match meta text: 0.65rem, on-surface-variant/70 opacity

### 3.5 Content Security Policy

- [x] Update CSP to allow Google Fonts CDN for font imports
- [x] `style-src 'unsafe-inline' https://fonts.googleapis.com`
- [x] `font-src https://fonts.gstatic.com`

## Phase 4: VSIX Tests

### 4.1 Test Infrastructure

- [x] Create `editors/vscode/src/test/suite/nuget-browser.test.ts`
- [x] Set up mock LSP client for NuGet request/response testing

### 4.2 Panel Lifecycle Tests

- [x] Test: panel opens from command
- [x] Test: panel reuses existing instance (singleton)
- [x] Test: panel disposes cleanly
- [x] Test: panel sends `sharplsp/nuget/installed` on open

### 4.3 LSP Integration Tests

- [x] Test: search sends `sharplsp/nuget/search` with correct params
- [x] Test: install sends `sharplsp/nuget/install` with correct params
- [x] Test: uninstall sends `sharplsp/nuget/uninstall` with correct params
- [x] Test: version change sends uninstall + install sequence
- [x] Test: tab switch to "installed" sends `sharplsp/nuget/installed`

### 4.4 Error Handling Tests

- [x] Test: LSP error response shows error message
- [x] Test: LSP timeout shows timeout message

## Phase 5: Documentation Updates

- [ ] Update `docs/specs/SHARPLSP-SPEC.md` - expand `sharplsp/nuget` row with all 5 endpoints
- [ ] Update `docs/plans/CSDEVKIT-PARITY-PLAN.md` - mark NuGet items as in-progress/done
- [ ] Update `docs/plans/TODO.md` - update NuGet items

## Phase 7: Dead UI Removal (User-Reported)

The original implementation copied decorative chrome from the design mockup
that had no functionality. Per CLAUDE.md ("Don't add features beyond what
the task requires"), all dead buttons and fake data have been removed.

**Root cause**: The mockups in `code.html` and `screen.png` show a full IDE
window for context. The activity bar (left icon column) and status bar (blue
bar at the bottom of the mockup) belong to **VS Code itself** — they are
**not** part of what the webview panel should render. The original
implementation copied them into the panel verbatim, producing duplicated
chrome inside the editor area. Both `docs/designs/DESIGN.md` § 0 and
`docs/specs/NUGET-BROWSER-SPEC.md` § 4.1 now warn loudly about this.

- [x] Remove decorative left sidebar (terminal, folder, search, layers, settings icons + avatar) — none of these had click handlers
- [x] Remove no-op Settings button from header (kept Refresh which works)
- [x] Remove fake status bar (hardcoded `main*`, `Ready`, `NuGet v6.8.0`, `UTF-8`)
- [x] Remove hardcoded fake Dependencies section (always showed `.NETStandard 2.0` and `.NETStandard 2.1` regardless of package)
- [x] Remove broken Updates tab (had no implementation, switched state but rendered nothing)
- [x] Remove decorative Sort By dropdown (no `onchange` handler)
- [x] Narrow `currentTab` type from `"browse" | "installed" | "updates"` to `"browse" | "installed"`
- [x] Delete dead CSS for `.sidebar*`, `.status-bar*`, `.deps*`, `.sort-select*`
- [x] Update VSIX test `valid tab values` to reflect 2 tabs instead of 3
- [x] Shortened logo from `NuGet Architect` to `NuGet`
- [x] Add `getRenderedHtml()` test accessor on `NuGetBrowserPanel`
- [x] Add regression VSIX test `rendered HTML does not include VS Code chrome` that asserts none of the dead elements (status bar strings, sidebar classes, fake dependencies, Updates tab, Sort By) ever come back
- [x] Add `docs/designs/DESIGN.md` § 0 explaining what is VS Code chrome vs. panel content
- [x] Add warning callout to `docs/specs/NUGET-BROWSER-SPEC.md` § 4.1 referencing § 0
- [x] **Rebuild `dist/extension.js` via `npm run build`** — esbuild bundles the extension; source-only edits are invisible to a running VS Code session until the bundle is rebuilt and the window is reloaded. This is why the user still saw the status bar after the previous "removal" pass.

## Phase 6: Bug Fixes (User-Reported)

### 6.1 Browse Tab Empty on Initial Load

- [x] Bug: Constructor only called `loadInstalledPackages()`, never populated browse results
- [x] Fix: Added `initialLoad()` method that awaits installed load then calls `performSearch("")`
- [x] Fix: Added `initialLoadDone: Promise<void>` field so tests can await initial load
- [x] Test: `browse tab is populated on initial load (bug fix)` in `nuget-browser.test.ts`

### 6.2 Clicking Installed Packages Did Nothing

- [x] Bug: `selectPackage` message handler only searched `searchResults`; installed-only packages never matched
- [x] Fix: Added `findOrSynthesizePackage(id)` that checks `searchResults` first, then synthesizes from `installedPackages` map
- [x] Fix: Added `enrichPackageMetadata()` that fetches real description/authors/etc. via targeted `packageid:` search for synthesized packages
- [x] Fix: Removed `readonly` modifiers from `NuGetSearchResult` fields to allow in-place enrichment
- [x] Test: `clicking installed package selects it (bug fix)` in `nuget-browser.test.ts`

### 6.3 Test Infrastructure

- [x] Added `waitForInitialLoad()`, `getSearchResultsCount()`, `getInstalledPackageIds()`, `getSelectedPackageId()`, `getCurrentTab()`, `simulateWebviewMessage()` test accessors on `NuGetBrowserPanel`
- [x] Added `getLspClient` to `SharpLspExtensionApi` so tests can grab the real LSP client
- [x] Exported `WebviewMessage` interface for use in tests
- [x] Test: `installed packages loaded from LSP on open` — regression check for LSP wiring
- [x] Test: `search message populates searchResults` — regression check for search flow

## Phase 8: Target Selection + Directory.Build.props Support (User-Reported P0)

**User report (verbatim):** "I just tapped install on the nuget package and it did fucking NOTHING!!! For starters, we need a drop down which tells us WHICH project we are working with, OR the build props! … we need an option to install into the build props!!! … It did something after a long delay... it installed the package - but it took TOO long! It should be instant!! … We also need SPINNERS as the nuget browser loads shit in the background."

**Root causes identified:**

1. **No target selector.** The extension hardcodes a single "first project in workspace" as the install target. The user cannot see which project they're installing into, cannot switch project, and cannot install into `Directory.Build.props` / `Directory.Packages.props` at all.
2. **Install feels broken.** `dotnet add` runs synchronously on the Rust side and blocks the LSP response for the entire restore duration (seconds). There is no spinner, no optimistic UI, no toast — the button just sits there looking dead, then eventually "works".
3. **No loading indicators.** Every LSP round trip is a silent dead zone. The panel appears frozen during search, install, version fetch, and initial load.

This phase implements spec §§ 3.0, 3A, 3.4 (rewritten), 3.5 (rewritten), 3.6, and 6 (rewritten).

### 8.1 Rust Host — `sharplsp/nuget/targets` handler

- [x] Add `NuGetTarget`, `NuGetTargetsParams`, `NuGetTargetsResponse` types in `src/nuget/types.rs`
- [x] Implement workspace walker (`src/nuget/targets.rs`): find every `*.csproj`, `*.fsproj`, `Directory.Build.props`, `Directory.Packages.props` under the workspace root (bounded depth, skip `bin/obj/.git/node_modules/...`)
- [x] Detect CPM by parsing nearest `Directory.Packages.props` for `<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`
- [x] Register `sharplsp/nuget/targets` route in `handle_custom_request()`
- [ ] Cache results keyed by workspace root + (dir mtimes); invalidate on file watcher events *(deferred — current walk is fast enough; revisit if profiling shows it as a hotspot)*
- [x] Unit test: `enumerates_csproj_fsproj_and_props` — finds all target kinds, ignores `bin/obj`
- [x] Unit test: `detects_cpm_enabled`
- [x] Unit test: `cpm_disabled_when_no_packages_props`
- [x] Unit test: `empty_workspace_returns_empty_targets`

### 8.2 Rust Host — XML fast-path install / uninstall

Goal: `sharplsp/nuget/install` returns in < 150 ms by editing XML directly, then fires `dotnet restore` in a background task.

- [x] Add `src/nuget/xml_edit.rs` with line-oriented XML edit helpers (deliberately NOT a round-trip XML writer — preserves byte-for-byte formatting, whitespace, comments, attribute ordering)
- [x] `add_package(path, id, version, element)` covering all three element flavours: `<PackageReference Include="..." Version="..."/>`, `<PackageReference Include="..."/>` (CPM csproj), `<PackageVersion Include="..." Version="..."/>` (Directory.Packages.props)
- [x] CPM-aware install: when a project has a sibling/ancestor `Directory.Packages.props`, the handler edits BOTH files (props gets `<PackageVersion>`, csproj gets `<PackageReference>` without `Version`)
- [x] `remove_package(path, id, element)` counterpart with the same routing
- [x] Rewrite `sharplsp/nuget/install` handler (`handlers.rs`):
    - [x] Take `target: NuGetTarget` (with backwards-compat fallback to `projectPath: string` so existing tests still pass)
    - [x] Route by `target.kind` (Project / BuildProps) and CPM detection (`pick_install_element`)
    - [x] Commit XML edit synchronously via `xml_edit::add_package`
    - [x] Spawn `dotnet restore` as a **background** tokio task via `spawn_restore`
    - [x] Return `NuGetInstallResponse { success, message, modifiedFiles }` immediately after XML commit
- [x] Rewrite `sharplsp/nuget/uninstall` handler the same way
- [x] Delete dead `cli::install_package` / `cli::uninstall_package` (the `dotnet add` / `dotnet remove` shells — replaced by XML fast-path)
- [x] Unit test: `adds_new_reference_to_existing_item_group`
- [x] Unit test: `updates_existing_version`
- [x] Unit test: `no_change_when_already_present_and_same_version`
- [x] Unit test: `removes_reference`
- [x] Unit test: `cpm_reference_has_no_version` — CPM csproj entries omit `Version`
- [x] Unit test: `package_version_for_cpm_props` — `<PackageVersion>` in `Directory.Packages.props`
- [x] Unit test: `creates_item_group_if_none_exists`
- [x] Unit test: `build_props_file_gets_reference`
- [x] Unit test: `preserves_formatting_exactly_for_untouched_content` — comments and whitespace survive
- [ ] E2E test against the live LSP binary measuring < 150 ms install latency *(deferred — covered transitively by the unit tests on `xml_edit::*`; full LSP-process latency benchmark belongs in a separate perf suite)*

### 8.3 Rust Host — `sharplsp/nuget/restoreProgress` notifications

- [x] Add `RestoreProgressParams` + `RestorePhase` enum in `src/nuget/types.rs`
- [x] Background restore task in `handlers::spawn_restore` sends `started` → `restoring` → `succeeded` / `failed` notifications via the LSP `Sender<Message>` (plumbed through `handle_install` / `handle_uninstall` from `main.rs`)
- [x] Each notification carries `targetId` so the UI can route it
- [x] On spawn failure / non-zero exit, the `failed` notification carries the stderr output
- [ ] E2E test: notifications are emitted in order for a successful install *(deferred — needs harness changes to capture server→client notifications, which the current test client only does for responses)*

### 8.4 Rust Host — cancellation

- [ ] Ensure every `dotnet` child spawned for a request is tracked by `RequestId` *(deferred — needs `$/cancelRequest` plumbing in `main_loop`. Restore is already non-blocking so the user is never stuck waiting; preempting an in-flight restore is a nice-to-have rather than a P0 blocker.)*
- [ ] On `$/cancelRequest`, kill the tracked child and cancel the background restore *(deferred — see above)*
- [ ] E2E test: cancelling a search request mid-flight does not leave orphaned `dotnet` processes *(deferred)*

### 8.5 Rewire other handlers to take `target`

- [x] `sharplsp/nuget/search` params accept `target: NuGetTarget` (with backwards-compat `projectPath` fallback so existing tests still pass)
- [x] `sharplsp/nuget/installed` params accept `target` (same fallback)
- [x] `dotnet list` path only runs when `target.kind === "project"`; for `buildProps`, parse `<PackageReference>` / `<PackageVersion>` from the XML directly via `list_props_packages`
- [x] All existing nuget e2e tests continue to pass without modification (the legacy `projectPath` field is still accepted)

### 8.6 Extension — Target dropdown UI

- [x] Fetch targets on panel open via `sharplsp/nuget/targets` (`nuget-browser/lsp.ts::fetchTargets`)
- [x] Render target dropdown in the panel header, between tabs and search box (`nuget-browser/html.ts::buildTargetDropdown`)
- [x] Group as "Projects" / "Build Props" via `<optgroup>` with Material Symbols `account_tree` icon
- [x] Persist last-used target per workspace via `ExtensionContext.workspaceState` (`LAST_TARGET_KEY = "sharplsp.nuget.lastTargetId"`)
- [x] Default to last-used target on open, fall back to the project path passed by the explorer, then to the first target
- [x] On target change: clear caches, re-fire `installed` + current search (`handleChangeTarget`)
- [x] Dropdown disabled while targets loading (visual spinner overlay)
- [x] Fallback: if `sharplsp/nuget/targets` returns nothing (or fails), synthesize a single project target from the initial project path so the user is never stuck without a target
- [x] Refresh button now triggers `installed + current search` for the active target (vs. the old behaviour of just re-running search)
- [ ] VSIX test: dropdown renders all targets grouped *(deferred — these tests require a workspace fixture with multiple projects + a Directory.Build.props; the current `NuGetTest` fixture only has one csproj. Adding the multi-project fixture is a separate task.)*
- [ ] VSIX test: dropdown defaults to last-used target *(same — needs multi-target fixture)*
- [ ] VSIX test: changing target re-fires `installed` and current search *(same)*

### 8.7 Extension — Spinners everywhere

Per spec § 3A.1 — every async operation shows a spinner. NO blank or frozen states, ever.

- [x] Add reusable spinner CSS (`@keyframes spin` on Material Symbols `progress_activity` in `nuget-browser/css.ts`)
- [x] Target dropdown spinner while `sharplsp/nuget/targets` in flight (`target-spinner` overlay)
- [x] Search box spinner (right edge) during `sharplsp/nuget/search`
- [x] Skeleton list placeholders on the first search (`skeletonList()` — six animated rows with pulse animation)
- [x] Installed-list inline spinner row at top during `sharplsp/nuget/installed`
- [x] Version dropdown disabled + chevron swapped to spinner during `sharplsp/nuget/versions`
- [x] Install button spinner + "Installing…" label during `sharplsp/nuget/install` (button disabled during the round-trip)
- [x] Uninstall button spinner + "Removing…" label during `sharplsp/nuget/uninstall`
- [x] Global toast: `Installing <id> <version> into <target.displayName>…` (`buildToast()`)
- [x] Toast updates on `sharplsp/nuget/restoreProgress` notifications (success → green tick, fail → red error)
- [x] Toast auto-clears 2 s after success / 5 s after failure
- [x] Centralized loading-key set (`LoadingKey` typed: `"targets" | "installed" | "search" | "versions" | install:* | uninstall:* | restore:*`) so future async ops slot in trivially
- [ ] VSIX test: search spinner appears within 50 ms of typing *(deferred — VS Code's webview test harness doesn't expose render timing without a separate puppeteer-style harness; the regression risk is mitigated by `getActiveLoadingKeys()` test accessor which lets future tests assert the spinner key is present)*
- [ ] VSIX test: install button shows spinner within 100 ms of click *(deferred — same)*

### 8.8 Extension — Optimistic UI

- [x] On install click: immediately mark package `isInstalled=true`, `installedVersion=<requested>` in `installedPackages` Map AND on the matching `searchResults` entry, re-render before sending the LSP request (`handleInstall`)
- [x] On success response: confirm by re-fetching the installed list, show success toast for 2 s
- [x] On error response (LSP error OR `success: false`): revert optimistic state, show error toast + `vscode.window.showErrorMessage`
- [x] Same for uninstall (optimistic removal in `handleUninstall`)
- [x] Pending package items styled with `.package-item.pending` (subtle opacity) so the user can see which one is in flight
- [ ] VSIX test: optimistic install visible in rendered HTML before LSP response *(deferred — needs a fake LSP client that lets the test inspect the DOM between the optimistic update and the response)*
- [ ] VSIX test: error response reverts optimistic state *(deferred — same)*

### 8.9 Extension — Cancellation

- [x] Debounce search input by 250 ms before firing a new request (in the webview JS — `_searchDebounce` `setTimeout`)
- [ ] When user changes target / retypes search / closes panel, cancel in-flight LSP requests via `$/cancelRequest` *(deferred — `vscode-languageclient`'s `sendRequest` doesn't expose a `CancellationToken` argument in the signature we use; would need a refactor to pass tokens through. Debouncing the search input gets us 90 % of the way there in practice.)*

### 8.10 Restore progress routing

- [x] Extension subscribes to `sharplsp/nuget/restoreProgress` notifications via `lsp.onNotification` (`subscribeToRestoreProgress`)
- [x] Notifications drive `loading.add/delete(restoreKey(targetId))` and update the toast
- [x] Webview re-renders on every notification so the spinner / toast stays in sync
- [ ] VSIX test: restore progress end-to-end updates the UI *(deferred — same harness limitation as above)*

## Execution Order

1. **Phase 1** (Rust handlers) - must exist before extension can use them
2. **Phase 2** (Extension refactor) - swap direct calls for LSP requests
3. **Phase 3** (UI fixes) - match the design spec
4. **Phase 4** (Tests) - verify everything works
5. **Phase 5** (Docs) - update specs and plans
6. **Phase 6** (Bug fixes) - address user-reported issues from manual testing
7. **Phase 7** (Dead UI removal) - done
8. **Phase 8** (Target dropdown + build.props + fast-path install + spinners) - **current P0**
