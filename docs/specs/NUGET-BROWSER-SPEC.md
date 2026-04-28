# NuGet Browser Specification

**Parent:** [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md)

## 1. Overview

SharpLsp provides a built-in NuGet package manager UI accessible from the Solution Explorer. Users can search, browse, install, update, and remove NuGet packages for any project in the solution. The UI is a webview panel rendered by the editor extension, but **all NuGet operations are routed through the LSP server** via custom requests. The extension NEVER talks directly to nuget.org or the dotnet CLI.

**Priority:** P2 (Phase 4 - Essential Features)

**Design reference:** `docs/designs/code.html`, `docs/designs/screen.png`

## 2. Architecture

### 2.1 Component Placement

NuGet operations live in the **Rust LSP host** (Tier 1). The dotnet CLI runs as a child process managed by the host. No sidecar involvement.

```
Editor Webview ──postMessage──> Extension ──LSP custom request──> Rust Host ──spawns──> dotnet CLI
                                                                      │
                                                                      ├── dotnet list <project> package
                                                                      ├── dotnet add <project> package
                                                                      ├── dotnet remove <project> package
                                                                      └── HTTP fetch to nuget.org API
```

### 2.2 Why Rust Host, Not Sidecar

- `dotnet` CLI operations are standalone commands, not Roslyn/FCS APIs
- No workspace or compilation context needed for package management
- NuGet.org search API is a simple HTTP GET - no .NET runtime required
- Keeps the extension editor-agnostic: any LSP client (Neovim, Helix, Zed) can consume the same requests
- Sidecar crash must not interfere with package management

### 2.3 Why NOT the Extension

- Editor extensions must remain thin LSP clients
- Direct CLI/HTTP calls from the extension make the feature VS Code-only
- Other editors (Neovim, Helix, Zed) cannot reuse extension-side logic
- LSP is the single integration point for all editors

## 3. LSP Custom Requests

### 3.0 Target Selection

**Critical:** every NuGet operation MUST be scoped to a concrete install target. The UI cannot assume the "current project" — the user MUST pick one explicitly from a dropdown rendered at the top of the panel (next to the Browse/Installed tabs). Without a selected target, the Install / Uninstall / Update actions MUST be disabled and display a tooltip "Select a target first".

#### 3.0.1 Target kinds

A target is one of:

| Kind | Example path | `dotnet` command | Notes |
|------|--------------|------------------|-------|
| `project` | `/repo/src/Foo/Foo.csproj` | `dotnet add <csproj> package …` | A single `.csproj` / `.fsproj`. |
| `project` | `/repo/src/Bar/Bar.fsproj` | `dotnet add <fsproj> package …` | Same as above for F#. |
| `buildProps` | `/repo/Directory.Build.props` | **Direct XML edit** — NOT `dotnet add` | `dotnet add` does not support props files. The Rust host edits the `<ItemGroup><PackageReference .../></ItemGroup>` block directly, preserving formatting. Requires follow-up `dotnet restore` at the props file's directory. |
| `buildProps` | `/repo/src/Directory.Packages.props` | Central Package Management | When CPM is enabled (`ManagePackageVersionsCentrally=true`), version lives in `Directory.Packages.props` as `<PackageVersion>`, and the `<PackageReference>` in the csproj has no `Version=`. The host must detect CPM and route accordingly. |

#### 3.0.2 `sharplsp/nuget/targets`

Enumerate all valid install targets in the currently open solution/workspace.

**Request:**

```typescript
interface NuGetTargetsParams {
    workspaceRoot: string;   // Absolute path to the workspace/solution root
}
```

**Response:**

```typescript
interface NuGetTargetsResponse {
    targets: NuGetTarget[];
    defaultTargetId: string | null;  // Last-used target for this workspace, or null
    cpmEnabled: boolean;              // Central Package Management detected
    cpmFile?: string;                 // Absolute path to Directory.Packages.props when cpmEnabled
}

interface NuGetTarget {
    id: string;              // Stable ID (absolute path)
    kind: "project" | "buildProps";
    displayName: string;     // e.g. "Foo.csproj" or "Directory.Build.props (solution root)"
    path: string;            // Absolute path
    language?: "csharp" | "fsharp";  // Only for kind=project
    framework?: string[];    // TFMs for kind=project
}
```

**Behavior:**
- Walk the workspace for `*.csproj`, `*.fsproj`, `Directory.Build.props`, `Directory.Packages.props`.
- Always include every props file found, even if it currently has no `<PackageReference>` items.
- Detect CPM by parsing the nearest `Directory.Packages.props` and checking `ManagePackageVersionsCentrally`.
- Persist last-used target per workspace (via extension `Memento` / workspaceState) so the dropdown defaults to it next session.

#### 3.0.3 UI contract

- A **target dropdown** is rendered in the panel header, to the **right of the tabs, left of the search box**.
- The dropdown lists projects first (grouped under a "Projects" header), then props files (grouped under a "Build Props" header).
- Changing the target:
  1. Re-fires `sharplsp/nuget/installed` for the new target.
  2. Re-fires the current search so `isInstalled` flags reflect the new target.
  3. Clears the details panel selection if the previously-selected package no longer makes sense.
- When CPM is enabled, installing to a `project` target MUST transparently update `Directory.Packages.props` (add/update `<PackageVersion>`) AND the csproj (`<PackageReference>` without a version). The host handles this — the UI does not care.
- When CPM is enabled AND the user explicitly picks the `Directory.Packages.props` target, the operation is a pure version-management edit (add/update `<PackageVersion>` only; no `<PackageReference>` is touched).

### 3.1 `sharplsp/nuget/search`

Search nuget.org for packages matching a query.

**Request:**

```typescript
interface NuGetSearchParams {
    query: string;           // Search query (empty = popular packages)
    target: NuGetTarget;     // Target (§ 3.0) — used to resolve isInstalled / installedVersion
    prerelease: boolean;     // Include prerelease versions
    take: number;            // Max results (default 50)
    skip: number;            // Pagination offset (default 0)
}
```

**Response:**

```typescript
interface NuGetSearchResponse {
    packages: NuGetPackageInfo[];
    totalHits: number;
}

interface NuGetPackageInfo {
    id: string;
    version: string;         // Latest stable version
    description: string;
    authors: string;
    iconUrl?: string;
    licenseUrl?: string;
    projectUrl?: string;
    published?: string;
    downloadCount: number;
    tags: string[];
    isInstalled: boolean;    // Whether installed in the target project
    installedVersion?: string;
}
```

**Behavior:**
- When `query` is empty, return popular packages (curated list of high-download-count packages)
- Cross-reference results with installed packages in the target project
- HTTP GET to `https://azuresearch-usnc.nuget.org/query?q={query}&prerelease={prerelease}&take={take}&skip={skip}`
- Cache search results for 60s to avoid hammering the API

### 3.2 `sharplsp/nuget/versions`

Get all available versions for a specific package.

**Request:**

```typescript
interface NuGetVersionsParams {
    packageId: string;       // NuGet package ID
}
```

**Response:**

```typescript
interface NuGetVersionsResponse {
    versions: string[];      // All versions, newest first
}
```

**Behavior:**
- HTTP GET to `https://api.nuget.org/v3-flatcontainer/{id}/index.json`
- Return versions in reverse chronological order (newest first)

### 3.3 `sharplsp/nuget/installed`

List installed packages for a target.

**Request:**

```typescript
interface NuGetInstalledParams {
    target: NuGetTarget;     // § 3.0
}
```

**Response:**

```typescript
interface NuGetInstalledResponse {
    packages: InstalledPackageInfo[];
}

interface InstalledPackageInfo {
    id: string;
    requestedVersion: string;
    resolvedVersion: string;
}
```

**Behavior:**
- Executes `dotnet list <projectPath> package --format json`
- Parses JSON output to extract installed packages across all target frameworks

### 3.4 `sharplsp/nuget/install`

Install or update a NuGet package against a chosen target (see § 3.0).

**Request:**

```typescript
interface NuGetInstallParams {
    target: NuGetTarget;     // Full target descriptor from sharplsp/nuget/targets
    packageId: string;
    version: string;
}
```

**Response:**

```typescript
interface NuGetInstallResponse {
    success: boolean;
    message: string;         // Human-readable result or error
    modifiedFiles: string[]; // Absolute paths to files the host actually wrote to
}
```

**Behavior by target kind:**

- `target.kind === "project"`:
  - **CPM disabled:** `dotnet add <target.path> package <packageId> --version <version>`.
  - **CPM enabled:** edit `Directory.Packages.props` to add/update `<PackageVersion Include="..." Version="..."/>`, then edit the csproj to add `<PackageReference Include="..."/>` (no `Version`). Do NOT shell out to `dotnet add` in CPM mode — it writes a `Version=` attribute that violates CPM.
- `target.kind === "buildProps"`:
  - Parse the props XML (preserving whitespace / comments), locate an `<ItemGroup>` containing `<PackageReference>` (create one if none exists), and add/update `<PackageReference Include="<id>" Version="<version>"/>`. When the file is `Directory.Packages.props`, use `<PackageVersion>` instead of `<PackageReference>`.
  - After writing, run `dotnet restore` at the props file's directory so the lockfile and `obj/project.assets.json` for every consuming project refresh.
- On success, trigger sidecar workspace reload for every project that transitively imports the modified file.
- Return `modifiedFiles` so the UI can show a toast like `Updated Directory.Build.props`.

### 3.5 `sharplsp/nuget/uninstall`

Remove a NuGet package from a target.

**Request:**

```typescript
interface NuGetUninstallParams {
    target: NuGetTarget;
    packageId: string;
}
```

**Response:**

```typescript
interface NuGetUninstallResponse {
    success: boolean;
    message: string;
    modifiedFiles: string[];
}
```

**Behavior by target kind:**

- `target.kind === "project"`: `dotnet remove <target.path> package <packageId>` (CPM aware — if CPM is on and the package version lives in `Directory.Packages.props`, also prompt the user whether to remove the `<PackageVersion>` entry).
- `target.kind === "buildProps"`: edit the XML to remove the matching `<PackageReference>` / `<PackageVersion>` node, then `dotnet restore`.
- On success, trigger sidecar workspace reload.

## 3A. Loading State & Instant Feedback

The current UI looks frozen because long-running operations (`dotnet add`, `dotnet restore`, search) give no visible feedback. That is a P0 bug. The spec now hard-requires the following:

### 3A.1 Spinners — every async operation

Every LSP round trip MUST show a spinner at a location that tells the user *what* is loading. Spinners use the Material Symbols `progress_activity` icon with a CSS `@keyframes spin` rotation (1 s linear infinite). No emoji, no text-only "Loading…".

| Operation | Spinner location | Extra UI |
|-----------|------------------|----------|
| `sharplsp/nuget/targets` (initial) | Target dropdown shows a centered spinner in place of its label. | Tabs / search disabled. |
| `sharplsp/nuget/installed` | Inline spinner row at the top of the package list under the "Installed" tab. | Cached stale list stays visible underneath. |
| `sharplsp/nuget/search` | Spinner inside the search box (right edge, replacing the search icon) AND a skeleton-list in the results area on first search. | Debounce 250 ms before firing. |
| `sharplsp/nuget/versions` | Spinner next to the version dropdown in the details panel. | Dropdown disabled until resolved. |
| `sharplsp/nuget/install` / `update` | Spinner replaces the Install button label ("Installing…" + spinner). Details panel shows a progress strip. | Global non-blocking toast: `Installing <id> <version> into <target.displayName>…` |
| `sharplsp/nuget/uninstall` | Spinner replaces the Uninstall button label. | Global toast. |

### 3A.2 Optimistic UI

Install / uninstall MUST update the UI optimistically:

1. The moment the user clicks Install, mark the package as `isInstalled: true` with `installedVersion: <requested>` in the local model and re-render.
2. Show the "Installing…" spinner state on the action button.
3. On success, swap the spinner for a checkmark for 1.5 s, then clear.
4. On failure, revert the optimistic state AND show an error toast with the LSP error message.

### 3A.3 Cancellation

Every spinner-bearing operation MUST be cancellable. When the user switches targets, re-types in the search box, or navigates away, any in-flight request for the previous state MUST be cancelled via LSP `$/cancelRequest`. The Rust host MUST honor cancellation — in particular, `dotnet` child processes spawned for a cancelled request MUST be killed.

### 3A.4 Install latency budget

`dotnet add` on a warm machine typically takes 2–8 s because of NuGet restore. That's **not acceptable as a blocking modal**. The contract is:

- **< 100 ms**: optimistic UI update is visible (§ 3A.2 step 1).
- **< 500 ms**: spinner + toast visible (§ 3A.1).
- **Host-side fast path**: for `kind: "project"` without CPM, the host MUST edit the csproj XML directly to add the `<PackageReference>` first, *then* fire `dotnet restore` in the background. The LSP `install` response returns as soon as the XML edit is committed (typically < 50 ms). The subsequent restore is reported via a separate `sharplsp/nuget/restoreProgress` notification (see § 3.6) so the UI can keep its spinner until restore finishes, without blocking the user from clicking Install on the next package.

### 3.6 `sharplsp/nuget/restoreProgress` (server → client notification)

```typescript
interface NuGetRestoreProgress {
    target: NuGetTarget;
    phase: "started" | "restoring" | "succeeded" | "failed";
    message?: string;
}
```

Fired by the Rust host while `dotnet restore` runs in the background after a fast-path XML edit. The extension routes these to the webview so the spinner can stay alive and the toast updates (`Restoring…` → `Restored` / `Restore failed`).

## 4. Webview UI

### 4.1 Design

The NuGet browser uses a webview panel rendered by the editor extension. The design follows the Material Design 3 dark theme specified in `docs/designs/code.html`.

> ⚠️ **CRITICAL — Read [`docs/designs/DESIGN.md`](../designs/DESIGN.md) § 0
> before touching this UI.** The mockups in `code.html` and `screen.png` show
> a full IDE window for context. The activity bar (left icon column) and
> status bar (blue bar at the bottom of the mockup) belong to **VS Code
> itself** and **MUST NOT** be reimplemented in the webview panel. The panel
> renders **only** the header (tabs + search + refresh), package list, and
> details panel — nothing else.

**Key design requirements:**
- Material Symbols Outlined icons (NOT emoji)
- Inter font family
- M3 dark color tokens (see `docs/designs/code.html` tailwind config)
- Two-column layout: package list | details panel
- Tabs: Browse | Installed
- **Target dropdown** (§ 3.0.3) between tabs and search — lists projects AND `Directory.Build.props` / `Directory.Packages.props`
- **Spinners** for every async op (§ 3A.1) — no blank/frozen states ever
- **NO** activity bar (VS Code provides one)
- **NO** status bar (VS Code provides one)
- **NO** decorative buttons without real handlers

### 4.2 Layout Structure

The panel renders only what's inside the editor area. Activity bar and
status bar shown below are **VS Code's own chrome** — drawn here for
orientation only, NOT part of the panel.

```
[VS Code activity bar — NOT part of panel]
+-----------------------------------------------------------------+
| Header: [logo] [Browse|Installed] [Target ▾] [search] [refresh] |   ← panel starts
+---------------------------+-------------------------------------+
| Package List              | Details Panel                       |
|                           |                                     |
| [Package Item]            | [Header]                            |
| [Package Item] (selected) | [Install ⟳ / Version ⟳]             |
| [Package Item]            | [Description]                       |
| [Package Item]            | [Info Grid]                         |
|                           | [Tags]                              |
+---------------------------+-------------------------------------+   ← panel ends
[VS Code status bar — NOT part of panel]
```

Target dropdown contents (example):

```
Projects
  ● Foo.csproj
    Bar.fsproj
    Baz.Tests.csproj
Build Props
    Directory.Build.props        (solution root)
    src/Directory.Packages.props (CPM)
```

### 4.3 Extension Responsibilities

The extension is responsible ONLY for:
1. Creating and managing the webview panel lifecycle
2. Rendering HTML/CSS/JS for the UI
3. Forwarding webview messages to LSP custom requests
4. Displaying LSP responses in the webview
5. **Reactive re-render on external edits.** The panel subscribes to the shared `projectDependencies` signal (see [VSCODE-REACTIVITY-SPEC.md](./VSCODE-REACTIVITY-SPEC.md)). When the csproj or `Directory.Packages.props` changes on disk, the panel reloads installed packages from the LSP automatically — no user refresh required. The Install/Remove button reflects the current file state at all times.

The extension MUST NOT:
- Execute `dotnet` CLI commands directly
- Make HTTP requests to nuget.org
- Parse .csproj/.fsproj files
- Perform any NuGet logic

### 4.4 Message Flow

```
User clicks "Install" in webview
  -> webview postMessage({ command: "install", data: { packageId, version } })
  -> extension receives message
  -> extension sends LSP request: sharplsp/nuget/install { projectPath, packageId, version }
  -> Rust host executes dotnet add ...
  -> Rust host returns { success: true, message: "..." }
  -> extension forwards result to webview
  -> webview updates UI
```

## 5. Error Handling

All LSP responses use `Result<T, E>` semantics:
- Success: return the typed response
- Failure: return LSP error with human-readable message

The extension displays errors via:
- `vscode.window.showErrorMessage()` for critical failures
- Inline error state in the webview for recoverable errors (e.g., search timeout)

## 6. Performance Targets

Every target below is **end-to-end, user-perceived** — measured from click to UI update, not just from LSP send to LSP response. Spinners (§ 3A.1) MUST appear within the "first paint" budget of each row.

| Operation | First paint (spinner/optimistic) | LSP response | Full completion | Method |
|-----------|----------------------------------|--------------|-----------------|--------|
| Open panel | < 50 ms | `sharplsp/nuget/targets` < 300 ms | < 1 s | Targets cached per workspace; refresh in background. |
| Search | < 50 ms (spinner) | < 500 ms p95 | < 500 ms p95 | HTTP GET with 60 s cache; 250 ms debounce before firing. |
| List installed | < 50 ms (spinner over stale cache) | < 300 ms from cache, < 2 s cold | < 2 s | `dotnet list` cold; subsequent calls served from in-memory cache keyed by target + csproj mtime. |
| Version list | < 50 ms (spinner) | < 500 ms | < 500 ms | HTTP GET with 5 min cache. |
| Install (project, no CPM) | < 100 ms (optimistic) | **< 150 ms** (XML fast path) | restore < 10 s (background, reported via `restoreProgress`) | Host edits csproj XML directly, returns immediately, fires `dotnet restore` in background. |
| Install (project, CPM) | < 100 ms (optimistic) | **< 150 ms** (XML fast path) | restore < 10 s (background) | Host edits `Directory.Packages.props` + csproj, then background restore. |
| Install (buildProps) | < 100 ms (optimistic) | **< 200 ms** (XML edit) | restore < 10 s (background) | Host edits props XML, then background restore at the props directory. |
| Uninstall | < 100 ms (optimistic) | < 200 ms (XML edit) | restore < 10 s (background) | Same fast-path model as install. |

**Non-negotiable:** the user must never wait > 200 ms for the Install button to visibly respond. If the restore is slow, the spinner keeps spinning in the background — the user is free to keep browsing, installing other packages, or close the panel.

## 7. Testing

### 7.1 Rust LSP Host Tests (E2E)

- [ ] `sharplsp/nuget/targets` enumerates all `.csproj`, `.fsproj`, `Directory.Build.props`, `Directory.Packages.props` in workspace
- [ ] `sharplsp/nuget/targets` detects Central Package Management
- [ ] `sharplsp/nuget/search` returns packages for known query
- [ ] `sharplsp/nuget/search` with empty query returns popular packages
- [ ] `sharplsp/nuget/search` marks installed packages correctly for a project target
- [ ] `sharplsp/nuget/search` marks installed packages correctly for a `Directory.Build.props` target
- [ ] `sharplsp/nuget/versions` returns version list for known package
- [ ] `sharplsp/nuget/installed` returns installed packages for a project target
- [ ] `sharplsp/nuget/installed` returns installed packages for a `Directory.Build.props` target
- [ ] `sharplsp/nuget/install` (project, no CPM) edits csproj XML and returns in < 150 ms, then fires restore in background
- [ ] `sharplsp/nuget/install` (project, CPM) updates `Directory.Packages.props` + csproj correctly
- [ ] `sharplsp/nuget/install` (buildProps) edits `Directory.Build.props` XML preserving formatting
- [ ] `sharplsp/nuget/install` (Directory.Packages.props) writes `<PackageVersion>` not `<PackageReference>`
- [ ] `sharplsp/nuget/uninstall` removes from a project target
- [ ] `sharplsp/nuget/uninstall` removes from a `Directory.Build.props` target
- [ ] `sharplsp/nuget/restoreProgress` notifications are emitted for each phase
- [ ] `$/cancelRequest` during a running `dotnet` child kills the child
- [ ] Error handling: invalid target path returns error
- [ ] Error handling: nonexistent package returns error
- [ ] Error handling: malformed `Directory.Build.props` returns a structured parse error

### 7.2 Extension Tests (VSIX)

- [ ] NuGet browser panel opens from command
- [ ] Panel reuses existing instance (singleton)
- [ ] Panel sends `sharplsp/nuget/targets` on open
- [ ] Target dropdown renders projects AND props files grouped
- [ ] Target dropdown defaults to last-used target from workspaceState
- [ ] Changing target re-fires `sharplsp/nuget/installed` and the current search
- [ ] Install button is disabled until a target is selected
- [ ] Spinner appears in the search box within 50 ms of typing
- [ ] Spinner appears on the Install button within 100 ms of click
- [ ] Optimistic state: package marked installed immediately, reverts on error
- [ ] Restore progress notifications update the spinner/toast
- [ ] `$/cancelRequest` is sent when the user switches target / retypes search mid-flight
- [ ] Panel sends correct LSP request for search (with `target` not `projectPath`)
- [ ] Panel sends correct LSP request for install to a project target
- [ ] Panel sends correct LSP request for install to a `Directory.Build.props` target
- [ ] Panel sends correct LSP request for uninstall
- [ ] Panel sends correct LSP request for version change
- [ ] Tab switching triggers correct data reload
- [ ] Panel disposes cleanly

## 8. Editor Support Matrix

| Editor | NuGet Search | Install/Remove | Browse UI |
|--------|-------------|----------------|-----------|
| VS Code | LSP request | LSP request | Webview panel |
| Neovim | LSP request | LSP request | Telescope picker (future) |
| Helix | LSP request | LSP request | CLI prompt (future) |
| Zed | LSP request | LSP request | Custom panel (future) |

All editors share the same LSP requests. Only the UI layer differs per editor.
