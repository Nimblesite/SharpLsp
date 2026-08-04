# [NUGET-BROWSER] NuGet Browser Specification

**Parent:** [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md)

## [NUGET-OVERVIEW] Overview

SharpLsp provides a built-in NuGet package manager UI accessible from the Solution Explorer. Users can search, browse, install, update, and remove NuGet packages for any project in the solution. The UI is a webview panel rendered by the editor extension, but **all NuGet operations are routed through the LSP server** via custom requests. The extension NEVER talks directly to nuget.org or the dotnet CLI.

**Priority:** P2 (Phase 4 - Essential Features)

**Design reference:** [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md)

## [NUGET-ARCHITECTURE] Architecture

### [NUGET-ARCHITECTURE-PLACEMENT] Component Placement

The **Rust LSP host** owns requests, target discovery, NuGet API calls, `dotnet` child processes, restore notifications, and sidecar reloads. It delegates package-file mutations to the C# sidecar's MSBuild editor as specified by [NUGET-XML-DOM]. Editor extensions MUST NOT perform package operations.

Implementations: [handlers.rs](../../src/sharplsp/src/nuget/handlers.rs), [nuget-browser.ts](../../src/editors/vscode/src/nuget-browser.ts), and the [host end-to-end tests](../../src/sharplsp/tests/nuget_e2e.rs).

```
Editor Webview ──postMessage──> Extension ──LSP request──> Rust Host
                                                               ├── HTTP / dotnet list / dotnet restore
                                                               └── IPC edit ──> C# Sidecar ──> MSBuild DOM
```

## [NUGET-XML-DOM] MSBuild XML Mutation

All `.csproj`, `.fsproj`, and `.props` package mutations MUST be delegated to the C# sidecar and performed with `Microsoft.Build.Construction.ProjectRootElement` using formatting preservation. String replacement, line splicing, and regex mutation are forbidden. Untouched whitespace, comments, attribute order, and conditional item groups MUST survive the edit. The Rust host orchestrates edits and starts background restore after the sidecar commits them.

## [NUGET-REQUESTS] LSP Custom Requests

### [NUGET-REQUESTS-TARGET] Target Selection

**Critical:** every NuGet operation MUST be scoped to a concrete install target. The UI cannot assume the "current project" — the user MUST pick one explicitly from a dropdown rendered at the top of the panel (next to the Browse/Installed tabs). Without a selected target, the Install / Uninstall / Update actions MUST be disabled and display a tooltip "Select a target first".

#### [NUGET-REQUESTS-TARGET-KINDS] Target Kinds

A target is one of:

| Kind | Example path | `dotnet` command | Notes |
|------|--------------|------------------|-------|
| `project` | `/repo/src/Foo/Foo.csproj` | MSBuild DOM edit + restore | A single `.csproj` / `.fsproj`. |
| `project` | `/repo/src/Bar/Bar.fsproj` | MSBuild DOM edit + restore | Same as above for F#. |
| `buildProps` | `/repo/Directory.Build.props` | MSBuild DOM edit + restore | The sidecar adds or updates `<PackageReference>` through [NUGET-XML-DOM], followed by restore at the props file's directory. |
| `buildProps` | `/repo/src/Directory.Packages.props` | Central Package Management | When CPM is enabled (`ManagePackageVersionsCentrally=true`), version lives in `Directory.Packages.props` as `<PackageVersion>`, and the `<PackageReference>` in the csproj has no `Version=`. The host must detect CPM and route accordingly. |

#### [NUGET-REQUESTS-TARGET-ENUMERATE] `sharplsp/nuget/targets`

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

#### [NUGET-REQUESTS-TARGET-UI] UI Contract

- A **target dropdown** is rendered in the panel header, to the **right of the tabs, left of the search box**.
- The dropdown lists projects first (grouped under a "Projects" header), then props files (grouped under a "Build Props" header).
- Changing the target:
  1. Re-fires `sharplsp/nuget/installed` for the new target.
  2. Re-fires the current search so `isInstalled` flags reflect the new target.
  3. Clears the details panel selection if the previously-selected package no longer makes sense.
- When CPM is enabled, installing to a `project` target MUST transparently update `Directory.Packages.props` (add/update `<PackageVersion>`) AND the csproj (`<PackageReference>` without a version). The host handles this — the UI does not care.
- When CPM is enabled AND the user explicitly picks the `Directory.Packages.props` target, the operation is a pure version-management edit (add/update `<PackageVersion>` only; no `<PackageReference>` is touched).

### [NUGET-REQUESTS-SEARCH] `sharplsp/nuget/search`

Search nuget.org for packages matching a query.

**Request:**

```typescript
interface NuGetSearchParams {
    query: string;           // Search query (empty = popular packages)
    target: NuGetTarget;     // [NUGET-REQUESTS-TARGET], used to resolve installation state
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
- Memoize search only through a Rust-host salsa query keyed by query, prerelease flag, `take`, `skip`, and a 60-second epoch input

### [NUGET-REQUESTS-VERSIONS] `sharplsp/nuget/versions`

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

### [NUGET-REQUESTS-INSTALLED] `sharplsp/nuget/installed`

List installed packages for a target.

**Request:**

```typescript
interface NuGetInstalledParams {
    target: NuGetTarget;     // [NUGET-REQUESTS-TARGET]
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

### [NUGET-REQUESTS-INSTALL] `sharplsp/nuget/install`

Install or update a NuGet package against a [NUGET-REQUESTS-TARGET].

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
  - **CPM disabled:** the sidecar adds or updates `<PackageReference Include="..." Version="..."/>` through [NUGET-XML-DOM], then the host starts background `dotnet restore`.
  - **CPM enabled:** the sidecar adds or updates `<PackageVersion Include="..." Version="..."/>` in `Directory.Packages.props`, then adds `<PackageReference Include="..."/>` without `Version` to the project; the host starts background restore.
- `target.kind === "buildProps"`:
  - Through [NUGET-XML-DOM], locate an `<ItemGroup>` containing `<PackageReference>` (create one if absent) and add or update `<PackageReference Include="<id>" Version="<version>"/>`. For `Directory.Packages.props`, use `<PackageVersion>`.
  - After writing, start `dotnet restore` at the props file's directory in the background so the lockfile and `obj/project.assets.json` for every consuming project refresh.
- On success, trigger sidecar workspace reload for every project that transitively imports the modified file.
- Return `modifiedFiles` so the UI can show a toast like `Updated Directory.Build.props`.

### [NUGET-REQUESTS-UNINSTALL] `sharplsp/nuget/uninstall`

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

- `target.kind === "project"`: remove the matching `<PackageReference>` from the project XML. With CPM, also prompt whether to remove its `<PackageVersion>` from `Directory.Packages.props`.
- `target.kind === "buildProps"`: edit the XML to remove the matching `<PackageReference>` or `<PackageVersion>` node, then start background `dotnet restore`.
- On success, trigger sidecar workspace reload.

## [NUGET-FEEDBACK] Loading and Feedback

### [NUGET-FEEDBACK-SPINNERS] Spinners

Every LSP round trip MUST show a spinner at a location that identifies what is loading. Spinners use a local accessible inline SVG or text symbol with a CSS `@keyframes spin` rotation (1s linear infinite); remote icon fonts, emoji, and text-only "Loading…" are forbidden by [WEB-DESIGN-TYPE].

| Operation | Spinner location | Extra UI |
|-----------|------------------|----------|
| `sharplsp/nuget/targets` (initial) | Target dropdown shows a centered spinner in place of its label. | Tabs / search disabled. |
| `sharplsp/nuget/installed` | Inline spinner row at the top of the package list under the "Installed" tab. | The currently rendered list stays visible until replacement state arrives. |
| `sharplsp/nuget/search` | Spinner inside the search box (right edge, replacing the search icon) AND a skeleton-list in the results area on first search. | Debounce 250 ms before firing. |
| `sharplsp/nuget/versions` | Spinner next to the version dropdown in the details panel. | Dropdown disabled until resolved. |
| `sharplsp/nuget/install` / `update` | Spinner replaces the Install button label ("Installing…" + spinner). Details panel shows a progress strip. | Global non-blocking toast: `Installing <id> <version> into <target.displayName>…` |
| `sharplsp/nuget/uninstall` | Spinner replaces the Uninstall button label. | Global toast. |

### [NUGET-FEEDBACK-OPTIMISTIC] Optimistic UI

Install / uninstall MUST update the UI optimistically:

1. The moment the user clicks Install, mark the package as `isInstalled: true` with `installedVersion: <requested>` in the local model and re-render.
2. Show the "Installing…" spinner state on the action button.
3. On success, swap the spinner for a checkmark for 1.5 s, then clear.
4. On failure, revert the optimistic state AND show an error toast with the LSP error message.

### [NUGET-FEEDBACK-CANCELLATION] Cancellation

Every spinner-bearing operation MUST be cancellable. When the user switches targets, re-types in the search box, or navigates away, any in-flight request for the previous state MUST be cancelled via LSP `$/cancelRequest`. The Rust host MUST honor cancellation — in particular, `dotnet` child processes spawned for a cancelled request MUST be killed.

### [NUGET-FEEDBACK-LATENCY] Install Latency Budget

Install and restore MUST NOT block the UI:

- **< 100 ms**: the [NUGET-FEEDBACK-OPTIMISTIC] update is visible.
- **< 500 ms**: the [NUGET-FEEDBACK-SPINNERS] spinner and toast are visible.
- **Edit fast path**: for `kind: "project"` without CPM, the host delegates the `<PackageReference>` edit through [NUGET-XML-DOM], then runs `dotnet restore` in the background. The `install` response returns after the edit commits, typically in <50 ms. [NUGET-FEEDBACK-RESTORE] keeps the spinner active until restore finishes without blocking further package operations.

### [NUGET-FEEDBACK-RESTORE] `sharplsp/nuget/restoreProgress`

```typescript
interface NuGetRestoreProgress {
    target: NuGetTarget;
    phase: "started" | "restoring" | "succeeded" | "failed";
    message?: string;
}
```

Fired by the Rust host while `dotnet restore` runs in the background after a fast-path XML edit. The extension routes these to the webview so the spinner can stay alive and the toast updates (`Restoring…` → `Restored` / `Restore failed`).

## [NUGET-WEBVIEW] Webview UI

### [NUGET-WEBVIEW-DESIGN] Design

The NuGet browser uses a webview panel rendered by the editor extension and MUST follow [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md). It renders only its header, package list, and details panel; VS Code supplies the surrounding activity and status bars.

**Key design requirements:**
- Local accessible text symbols or inline SVG icons, never emoji or external icon fonts ([WEB-DESIGN-TYPE])
- System UI font stack ([WEB-DESIGN-TYPE])
- Semantic light and dark tokens ([WEB-DESIGN-COLOR])
- Two-column layout: package list | details panel
- Tabs: Browse | Installed
- **Target dropdown** ([NUGET-REQUESTS-TARGET-UI]) between tabs and search — lists projects AND `Directory.Build.props` / `Directory.Packages.props`
- **Spinners** for every async operation ([NUGET-FEEDBACK-SPINNERS])
- **NO** decorative buttons without real handlers

### [NUGET-WEBVIEW-LAYOUT] Layout Structure

```
+-----------------------------------------------------------------+
| Header: [logo] [Browse|Installed] [Target ▾] [search] [refresh] |
+---------------------------+-------------------------------------+
| Package List              | Details Panel                       |
|                           |                                     |
| [Package Item]            | [Header]                            |
| [Package Item] (selected) | [Install ⟳ / Version ⟳]             |
| [Package Item]            | [Description]                       |
| [Package Item]            | [Info Grid]                         |
|                           | [Tags]                              |
+---------------------------+-------------------------------------+
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

### [NUGET-WEBVIEW-EXTENSION] Extension Responsibilities

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

### [NUGET-WEBVIEW-FLOW] Message Flow

```
User clicks "Install" in webview
  -> webview postMessage({ command: "install", data: { packageId, version } })
  -> extension receives message
  -> extension sends LSP request: sharplsp/nuget/install { target, packageId, version }
  -> Rust host delegates the target edit to the C# sidecar and starts background restore
  -> Rust host returns { success: true, message: "...", modifiedFiles: [...] }
  -> extension forwards result to webview
  -> webview updates UI
```

## [NUGET-ERRORS] Error Handling

All LSP responses use `Result<T, E>` semantics:
- Success: return the typed response
- Failure: return LSP error with human-readable message

The extension displays errors via:
- `vscode.window.showErrorMessage()` for critical failures
- Inline error state in the webview for recoverable errors (e.g., search timeout)

## [NUGET-PERFORMANCE] Performance Targets

Every target below is end-to-end, measured from click to UI update. [NUGET-FEEDBACK-SPINNERS] MUST appear within each row's first-paint budget.

| Operation | First paint (spinner/optimistic) | LSP response | Full completion | Method |
|-----------|----------------------------------|--------------|-----------------|--------|
| Open panel | < 50 ms | `sharplsp/nuget/targets` < 300 ms | < 1 s | Rust-host salsa query keyed by workspace root and filesystem generation; refresh in background. |
| Search | < 50 ms (spinner) | < 500 ms p95 | < 500 ms p95 | Rust-host salsa query with a 60s epoch input; 250ms debounce before firing. |
| List installed | < 50 ms (spinner over rendered state) | < 300 ms from salsa, < 2 s cold | < 2 s | `dotnet list` on salsa miss; query inputs include target and project-file fingerprint. |
| Version list | < 50 ms (spinner) | < 500 ms | < 500 ms | Rust-host salsa query with a five-minute epoch input. |
| Install (project, no CPM) | < 100 ms (optimistic) | **< 150 ms** (XML fast path) | restore < 10 s (background, reported via `restoreProgress`) | Sidecar commits [NUGET-XML-DOM], host starts background restore. |
| Install (project, CPM) | < 100 ms (optimistic) | **< 150 ms** (XML fast path) | restore < 10 s (background) | Sidecar edits `Directory.Packages.props` + project, host starts restore. |
| Install (buildProps) | < 100 ms (optimistic) | **< 200 ms** (XML edit) | restore < 10 s (background) | Sidecar edits props, host restores at the props directory. |
| Uninstall | < 100 ms (optimistic) | < 200 ms (XML edit) | restore < 10 s (background) | Same fast-path model as install. |

## [NUGET-TESTS] Testing

### [NUGET-TESTS-HOST] Rust LSP Host Tests

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

### [NUGET-TESTS-EXTENSION] Extension Tests

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

## [NUGET-EDITORS] Editor Support Matrix

VS Code provides the webview in [NUGET-WEBVIEW]; other editors may consume the same custom requests, but this specification mandates no additional editor UI.
