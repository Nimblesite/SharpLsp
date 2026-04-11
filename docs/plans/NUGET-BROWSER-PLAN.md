# NuGet Browser Implementation Plan

**Spec:** [NUGET-BROWSER-SPEC.md](../specs/NUGET-BROWSER-SPEC.md)
**Design:** `docs/designs/code.html`, `docs/designs/screen.png`

## Current State (Fixed)

All critical issues have been resolved:

1. ~~**Extension talks directly to nuget.org and dotnet CLI**~~ - FIXED. All operations go through `forge/nuget/*` LSP custom requests. Extension is a thin UI shell.
2. ~~**UI uses emoji icons**~~ - FIXED. All icons replaced with Material Symbols Outlined spans.
3. ~~**Duplicate settings cog**~~ - FIXED. Settings in header + sidebar bottom per design spec.
4. ~~**Missing Dependencies section**~~ - FIXED. Dependencies section added to details panel.
5. **No logging** - Fixed (logging added throughout).
6. ~~**No tests**~~ - FIXED. Rust E2E tests (`tests/nuget_e2e.rs`) and VSIX tests (`nuget-browser.test.ts`) added.
7. ~~**Font/spacing mismatch**~~ - FIXED. Inter font + Material Symbols imported via Google Fonts CDN. CSS matches M3 dark theme.
8. ~~**Browse tab empty on load**~~ - FIXED. Constructor now calls `performSearch("")` after loading installed packages to populate popular packages.
9. ~~**Clicking installed packages does nothing**~~ - FIXED. Added `findOrSynthesizePackage()` that resolves package IDs from both `searchResults` and `installedPackages` map. Installed-only packages are enriched with real metadata via a targeted search on selection.

## Phase 1: Rust LSP Host - NuGet Request Handlers

Implement `forge/nuget/*` custom request handlers in the Rust LSP host. These wrap the dotnet CLI and nuget.org HTTP API.

### 1.1 Types & Module Structure

- [x] Create `src/nuget/` module (mod.rs, types.rs, cache.rs, search.rs, cli.rs, handlers.rs)
- [x] Define request/response types for all 5 endpoints (see spec section 3)
- [x] Register `forge/nuget/*` routes in `handle_custom_request()` in `src/main.rs`

### 1.2 `forge/nuget/search` Handler

- [x] HTTP GET to `https://azuresearch-usnc.nuget.org/query` with query params
- [x] Parse NuGet v3 search API JSON response
- [x] Cross-reference with installed packages (call `dotnet list` internally)
- [x] Return `NuGetSearchResponse` with `isInstalled` / `installedVersion` populated
- [x] Cache search results for 60s (avoid API hammering)
- [x] Popular packages fallback when query is empty

### 1.3 `forge/nuget/versions` Handler

- [x] HTTP GET to `https://api.nuget.org/v3-flatcontainer/{id}/index.json`
- [x] Parse version list, return newest-first
- [x] Cache version lists for 5 minutes

### 1.4 `forge/nuget/installed` Handler

- [x] Execute `dotnet list <projectPath> package --format json`
- [x] Parse JSON output, extract packages across all target frameworks
- [x] Return `NuGetInstalledResponse`

### 1.5 `forge/nuget/install` Handler

- [x] Execute `dotnet add <projectPath> package <packageId> --version <version>`
- [x] Parse stdout/stderr for success/failure
- [ ] On success, notify sidecar to reload workspace (project file changed)
- [x] Return `NuGetInstallResponse`

### 1.6 `forge/nuget/uninstall` Handler

- [x] Execute `dotnet remove <projectPath> package <packageId>`
- [x] Parse stdout/stderr for success/failure
- [ ] On success, notify sidecar to reload workspace
- [x] Return `NuGetUninstallResponse`

### 1.7 E2E Tests (Rust)

- [x] Test `forge/nuget/search` returns results for "Newtonsoft"
- [x] Test `forge/nuget/search` with empty query returns popular packages
- [x] Test `forge/nuget/search` marks installed packages correctly
- [x] Test `forge/nuget/versions` returns versions for "Newtonsoft.Json"
- [x] Test `forge/nuget/installed` returns packages for test project
- [x] Test `forge/nuget/install` adds package to test project
- [x] Test `forge/nuget/uninstall` removes package from test project
- [x] Test error handling: invalid project path
- [x] Test error handling: nonexistent package ID

## Phase 2: Extension - Refactor to LSP Requests

Gut the direct CLI/HTTP calls from the extension. Replace with LSP custom requests.

### 2.1 Remove Direct Calls

- [x] Remove `execFileAsync` calls from `nuget-browser.ts`
- [x] Remove `fetch()` calls to nuget.org from `nuget-browser.ts`
- [x] Remove `node:child_process` import

### 2.2 Add LSP Request Wrappers

- [x] Add `searchPackages(query, projectPath)` that sends `forge/nuget/search`
- [x] Add `getVersions(packageId)` that sends `forge/nuget/versions`
- [x] Add `getInstalledPackages(projectPath)` that sends `forge/nuget/installed`
- [x] Add `installPackage(projectPath, packageId, version)` that sends `forge/nuget/install`
- [x] Add `uninstallPackage(projectPath, packageId)` that sends `forge/nuget/uninstall`

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
- [x] Test: panel sends `forge/nuget/installed` on open

### 4.3 LSP Integration Tests

- [x] Test: search sends `forge/nuget/search` with correct params
- [x] Test: install sends `forge/nuget/install` with correct params
- [x] Test: uninstall sends `forge/nuget/uninstall` with correct params
- [x] Test: version change sends uninstall + install sequence
- [x] Test: tab switch to "installed" sends `forge/nuget/installed`

### 4.4 Error Handling Tests

- [x] Test: LSP error response shows error message
- [x] Test: LSP timeout shows timeout message

## Phase 5: Documentation Updates

- [ ] Update `docs/specs/forge-spec.md` - expand `forge/nuget` row with all 5 endpoints
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
- [x] Added `getLspClient` to `ForgeExtensionApi` so tests can grab the real LSP client
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

### 8.1 Rust Host — `forge/nuget/targets` handler

- [ ] Add `NuGetTarget`, `NuGetTargetsParams`, `NuGetTargetsResponse` types in `src/nuget/types.rs`
- [ ] Implement workspace walker: find every `*.csproj`, `*.fsproj`, `Directory.Build.props`, `Directory.Packages.props` under the workspace root
- [ ] Detect CPM by parsing nearest `Directory.Packages.props` for `<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`
- [ ] Register `forge/nuget/targets` route in `handle_custom_request()`
- [ ] Cache results keyed by workspace root + (dir mtimes); invalidate on file watcher events
- [ ] E2E test: enumerates all target kinds
- [ ] E2E test: detects CPM correctly
- [ ] E2E test: returns empty targets gracefully for empty workspace

### 8.2 Rust Host — XML fast-path install / uninstall

Goal: `forge/nuget/install` returns in < 150 ms by editing XML directly, then fires `dotnet restore` in a background task.

- [ ] Add `src/nuget/xml_edit.rs` with pure XML edit helpers (use `quick-xml` or similar; preserve formatting, whitespace, comments)
- [ ] `add_package_reference(csproj_path, id, version) -> Result<ModifiedFiles>` — edits csproj XML directly
- [ ] `add_package_reference_cpm(csproj_path, props_path, id, version)` — edits both files for CPM
- [ ] `add_package_reference_to_props(props_path, id, version)` — handles `Directory.Build.props` and `Directory.Packages.props`
- [ ] `remove_package_reference*` counterparts
- [ ] Rewrite `forge/nuget/install` handler:
    - [ ] Take `target: NuGetTarget` instead of `projectPath: string`
    - [ ] Route by `target.kind` and CPM detection
    - [ ] Commit XML edit synchronously
    - [ ] Spawn `dotnet restore` as a **background** tokio task
    - [ ] Return `NuGetInstallResponse { success, message, modifiedFiles }` immediately after XML commit
- [ ] Rewrite `forge/nuget/uninstall` handler the same way
- [ ] E2E test: install (project, no CPM) returns in < 150 ms
- [ ] E2E test: install (project, CPM) writes `<PackageVersion>` to props AND `<PackageReference>` without version to csproj
- [ ] E2E test: install (buildProps) preserves formatting of `Directory.Build.props`
- [ ] E2E test: uninstall on all target kinds

### 8.3 Rust Host — `forge/nuget/restoreProgress` notifications

- [ ] Add notification type in `src/nuget/types.rs`
- [ ] Background restore task sends `started` → `restoring` → `succeeded` / `failed` notifications via the LSP client
- [ ] Each notification carries the `target` so the UI can route it
- [ ] E2E test: notifications are emitted in order for a successful install
- [ ] E2E test: `failed` notification carries the stderr output

### 8.4 Rust Host — cancellation

- [ ] Ensure every `dotnet` child spawned for a request is tracked by `RequestId`
- [ ] On `$/cancelRequest`, kill the tracked child process and clean up any in-flight XML edits (they should already be committed; just cancel the restore)
- [ ] E2E test: cancelling a search request mid-flight does not leave orphaned `dotnet` processes

### 8.5 Rewire other handlers to take `target`

- [ ] `forge/nuget/search` params switch from `projectPath` to `target`
- [ ] `forge/nuget/installed` params switch from `projectPath` to `target`
- [ ] `dotnet list` path only runs when `target.kind === "project"`; for `buildProps`, parse the XML directly
- [ ] Update all existing E2E tests for the new param shape

### 8.6 Extension — Target dropdown UI

- [ ] Fetch targets on panel open via `forge/nuget/targets`
- [ ] Render target dropdown in the panel header, between tabs and search box
- [ ] Group as "Projects" / "Build Props" with Material Symbols icons (`account_tree` / `description`)
- [ ] Persist last-used target per workspace via `ExtensionContext.workspaceState`
- [ ] Default to last-used target on open, otherwise first project
- [ ] On target change: re-fire `installed` + current search, clear invalid details selection
- [ ] Disable Install / Uninstall buttons (+ tooltip "Select a target first") when no target is selected
- [ ] VSIX test: dropdown renders all targets grouped
- [ ] VSIX test: dropdown defaults to last-used target
- [ ] VSIX test: changing target re-fires `installed` and current search
- [ ] VSIX test: install button disabled without target

### 8.7 Extension — Spinners everywhere

Per spec § 3A.1 — every async operation shows a spinner. NO blank or frozen states, ever.

- [ ] Add reusable spinner CSS (`@keyframes spin` on Material Symbols `progress_activity`)
- [ ] Target dropdown spinner while `forge/nuget/targets` in flight
- [ ] Search box spinner (replaces search icon) during `forge/nuget/search`
- [ ] Skeleton list placeholders on the first search
- [ ] Installed-list inline spinner row at top during `forge/nuget/installed`
- [ ] Version dropdown spinner during `forge/nuget/versions`
- [ ] Install button spinner + "Installing…" label during `forge/nuget/install`
- [ ] Uninstall button spinner + "Uninstalling…" label during `forge/nuget/uninstall`
- [ ] Global toast: `Installing <id> <version> into <target.displayName>…`
- [ ] Toast updates on `forge/nuget/restoreProgress` notifications
- [ ] VSIX test: search spinner appears within 50 ms of typing
- [ ] VSIX test: install button shows spinner within 100 ms of click
- [ ] VSIX test: toast appears within 500 ms
- [ ] VSIX test: spinner clears on `succeeded` restore progress
- [ ] VSIX test: spinner shows error state on `failed` restore progress

### 8.8 Extension — Optimistic UI

- [ ] On install click: immediately mark package `isInstalled=true`, `installedVersion=<requested>` in local model, re-render
- [ ] On success response: swap spinner for checkmark for 1.5 s
- [ ] On error response: revert optimistic state + show error toast with LSP error message
- [ ] Same for uninstall (optimistic removal)
- [ ] VSIX test: optimistic install visible in rendered HTML before LSP response
- [ ] VSIX test: error response reverts optimistic state

### 8.9 Extension — Cancellation

- [ ] When user changes target / retypes search / closes panel, cancel in-flight LSP requests via `$/cancelRequest`
- [ ] Debounce search input by 250 ms before firing a new request
- [ ] VSIX test: retyping during an in-flight search cancels the previous request
- [ ] VSIX test: changing target cancels in-flight requests

### 8.10 Restore progress routing

- [ ] Extension subscribes to `forge/nuget/restoreProgress` notifications from the LSP client
- [ ] Routes them into the webview via postMessage
- [ ] Webview updates the matching spinner + toast
- [ ] VSIX test: restore progress end-to-end updates the UI

## Execution Order

1. **Phase 1** (Rust handlers) - must exist before extension can use them
2. **Phase 2** (Extension refactor) - swap direct calls for LSP requests
3. **Phase 3** (UI fixes) - match the design spec
4. **Phase 4** (Tests) - verify everything works
5. **Phase 5** (Docs) - update specs and plans
6. **Phase 6** (Bug fixes) - address user-reported issues from manual testing
7. **Phase 7** (Dead UI removal) - done
8. **Phase 8** (Target dropdown + build.props + fast-path install + spinners) - **current P0**
