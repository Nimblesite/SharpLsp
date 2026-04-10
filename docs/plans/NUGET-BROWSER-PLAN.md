# NuGet Browser Implementation Plan

**Spec:** [NUGET-BROWSER-SPEC.md](../specs/NUGET-BROWSER-SPEC.md)
**Design:** `docs/designs/code.html`, `docs/designs/screen.png`

## Current State (Broken)

The NuGet browser exists but is fundamentally wrong:

1. **Extension talks directly to nuget.org and dotnet CLI** - ILLEGAL. All NuGet operations MUST go through the LSP via `forge/nuget/*` custom requests. The extension is a thin UI shell, nothing more.
2. **UI uses emoji icons** - The design spec uses Material Symbols Outlined. Not a single emoji should exist in the UI.
3. **Duplicate settings cog** - Settings icon appears in BOTH the sidebar (bottom) AND the header (top right). The design has sync + settings in the header only, with settings in the sidebar bottom only.
4. **Missing Dependencies section** - The design shows a Dependencies section in the details panel listing target frameworks. Not implemented.
5. **No logging** - Fixed (logging added throughout).
6. **No tests** - Zero automated tests for the NuGet browser. ILLEGAL per CLAUDE.md.
7. **Font/spacing mismatch** - Not using Inter font or Material Symbols font imports. CSS doesn't match the design's M3 dark theme spacing.

## Phase 1: Rust LSP Host - NuGet Request Handlers

Implement `forge/nuget/*` custom request handlers in the Rust LSP host. These wrap the dotnet CLI and nuget.org HTTP API.

### 1.1 Types & Module Structure

- [ ] Create `src/nuget.rs` module
- [ ] Define request/response types for all 5 endpoints (see spec section 3)
- [ ] Register `forge/nuget/*` routes in `handle_custom_request()` in `src/main.rs`

### 1.2 `forge/nuget/search` Handler

- [ ] HTTP GET to `https://azuresearch-usnc.nuget.org/query` with query params
- [ ] Parse NuGet v3 search API JSON response
- [ ] Cross-reference with installed packages (call `dotnet list` internally)
- [ ] Return `NuGetSearchResponse` with `isInstalled` / `installedVersion` populated
- [ ] Cache search results for 60s (avoid API hammering)
- [ ] Popular packages fallback when query is empty

### 1.3 `forge/nuget/versions` Handler

- [ ] HTTP GET to `https://api.nuget.org/v3-flatcontainer/{id}/index.json`
- [ ] Parse version list, return newest-first
- [ ] Cache version lists for 5 minutes

### 1.4 `forge/nuget/installed` Handler

- [ ] Execute `dotnet list <projectPath> package --format json`
- [ ] Parse JSON output, extract packages across all target frameworks
- [ ] Return `NuGetInstalledResponse`

### 1.5 `forge/nuget/install` Handler

- [ ] Execute `dotnet add <projectPath> package <packageId> --version <version>`
- [ ] Parse stdout/stderr for success/failure
- [ ] On success, notify sidecar to reload workspace (project file changed)
- [ ] Return `NuGetInstallResponse`

### 1.6 `forge/nuget/uninstall` Handler

- [ ] Execute `dotnet remove <projectPath> package <packageId>`
- [ ] Parse stdout/stderr for success/failure
- [ ] On success, notify sidecar to reload workspace
- [ ] Return `NuGetUninstallResponse`

### 1.7 E2E Tests (Rust)

- [ ] Test `forge/nuget/search` returns results for "Newtonsoft"
- [ ] Test `forge/nuget/search` with empty query returns popular packages
- [ ] Test `forge/nuget/search` marks installed packages correctly
- [ ] Test `forge/nuget/versions` returns versions for "Newtonsoft.Json"
- [ ] Test `forge/nuget/installed` returns packages for test project
- [ ] Test `forge/nuget/install` adds package to test project
- [ ] Test `forge/nuget/uninstall` removes package from test project
- [ ] Test error handling: invalid project path
- [ ] Test error handling: nonexistent package ID

## Phase 2: Extension - Refactor to LSP Requests

Gut the direct CLI/HTTP calls from the extension. Replace with LSP custom requests.

### 2.1 Remove Direct Calls

- [ ] Remove `execFileAsync` calls from `nuget-browser.ts`
- [ ] Remove `fetch()` calls to nuget.org from `nuget-browser.ts`
- [ ] Remove `node:child_process` import

### 2.2 Add LSP Request Wrappers

- [ ] Add `searchPackages(query, projectPath)` that sends `forge/nuget/search`
- [ ] Add `getVersions(packageId)` that sends `forge/nuget/versions`
- [ ] Add `getInstalledPackages(projectPath)` that sends `forge/nuget/installed`
- [ ] Add `installPackage(projectPath, packageId, version)` that sends `forge/nuget/install`
- [ ] Add `uninstallPackage(projectPath, packageId)` that sends `forge/nuget/uninstall`

### 2.3 Wire Up Message Handler

- [ ] Update `handleMessage()` to use LSP wrappers instead of direct calls
- [ ] Ensure error responses from LSP are displayed in webview + notification

## Phase 3: UI - Match Design Spec

Fix the webview HTML/CSS to match `docs/designs/code.html` exactly.

### 3.1 Fonts & Icons

- [ ] Add Google Fonts import for Inter (300-800 weights)
- [ ] Add Material Symbols Outlined font import
- [ ] Replace ALL emoji with Material Symbols Outlined spans
- [ ] Icon mapping: folder, search, layers, settings, package_2, download, person, verified_user, database, api, security, sync, expand_more, open_in_new, link, account_tree, chevron_right

### 3.2 Layout Fixes

- [ ] Remove duplicate settings cog from header (keep only in sidebar bottom)
- [ ] Header: logo + nav tabs on left, search + sync button on right
- [ ] Sidebar: terminal icon (dimmed) at top, nav icons, settings at bottom with avatar
- [ ] Package list: proper padding (p-4, space-y-2), border-l-2 on selected
- [ ] Details panel: w-96, bg-surface-container-low

### 3.3 Missing Sections

- [ ] Add Dependencies section to details panel (target frameworks list)
- [ ] Dependencies items: account_tree icon, framework name, hover chevron_right
- [ ] Style: bg-surface-container rounded-md, hover:bg-surface-container-high

### 3.4 Typography & Spacing

- [ ] Match tailwind spacing scale from design (p-6, gap-4, etc.)
- [ ] Match font sizes: logo 18px bold, nav 13px, package name 15px semibold
- [ ] Match label styles: uppercase, tracking-widest, 0.6rem, font-bold
- [ ] Match tag styles: px-2 py-1, bg-surface-container-highest, rounded-full, 0.6rem
- [ ] Match meta text: 0.65rem, on-surface-variant/70 opacity

### 3.5 Content Security Policy

- [ ] Update CSP to allow Google Fonts CDN for font imports
- [ ] `style-src 'unsafe-inline' https://fonts.googleapis.com`
- [ ] `font-src https://fonts.gstatic.com`

## Phase 4: VSIX Tests

### 4.1 Test Infrastructure

- [ ] Create `editors/vscode/src/test/suite/nuget-browser.test.ts`
- [ ] Set up mock LSP client for NuGet request/response testing

### 4.2 Panel Lifecycle Tests

- [ ] Test: panel opens from command
- [ ] Test: panel reuses existing instance (singleton)
- [ ] Test: panel disposes cleanly
- [ ] Test: panel sends `forge/nuget/installed` on open

### 4.3 LSP Integration Tests

- [ ] Test: search sends `forge/nuget/search` with correct params
- [ ] Test: install sends `forge/nuget/install` with correct params
- [ ] Test: uninstall sends `forge/nuget/uninstall` with correct params
- [ ] Test: version change sends uninstall + install sequence
- [ ] Test: tab switch to "installed" sends `forge/nuget/installed`

### 4.4 Error Handling Tests

- [ ] Test: LSP error response shows error message
- [ ] Test: LSP timeout shows timeout message

## Phase 5: Documentation Updates

- [ ] Update `docs/specs/forge-spec.md` - expand `forge/nuget` row with all 5 endpoints
- [ ] Update `docs/plans/CSDEVKIT-PARITY-PLAN.md` - mark NuGet items as in-progress/done
- [ ] Update `docs/plans/TODO.md` - update NuGet items

## Execution Order

1. **Phase 1** (Rust handlers) - must exist before extension can use them
2. **Phase 2** (Extension refactor) - swap direct calls for LSP requests
3. **Phase 3** (UI fixes) - match the design spec
4. **Phase 4** (Tests) - verify everything works
5. **Phase 5** (Docs) - update specs and plans
