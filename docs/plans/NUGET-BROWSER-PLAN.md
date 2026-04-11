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

## Execution Order

1. **Phase 1** (Rust handlers) - must exist before extension can use them
2. **Phase 2** (Extension refactor) - swap direct calls for LSP requests
3. **Phase 3** (UI fixes) - match the design spec
4. **Phase 4** (Tests) - verify everything works
5. **Phase 5** (Docs) - update specs and plans
6. **Phase 6** (Bug fixes) - address user-reported issues from manual testing
