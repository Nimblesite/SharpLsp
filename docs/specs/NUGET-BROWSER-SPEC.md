# NuGet Browser Specification

**Parent:** [FORGE-SPEC.md](FORGE-SPEC.md)

## 1. Overview

Forge provides a built-in NuGet package manager UI accessible from the Solution Explorer. Users can search, browse, install, update, and remove NuGet packages for any project in the solution. The UI is a webview panel rendered by the editor extension, but **all NuGet operations are routed through the LSP server** via custom requests. The extension NEVER talks directly to nuget.org or the dotnet CLI.

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

### 3.1 `forge/nuget/search`

Search nuget.org for packages matching a query.

**Request:**

```typescript
interface NuGetSearchParams {
    query: string;           // Search query (empty = popular packages)
    projectPath: string;     // Absolute path to .csproj/.fsproj
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

### 3.2 `forge/nuget/versions`

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

### 3.3 `forge/nuget/installed`

List installed packages for a project.

**Request:**

```typescript
interface NuGetInstalledParams {
    projectPath: string;     // Absolute path to .csproj/.fsproj
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

### 3.4 `forge/nuget/install`

Install or update a NuGet package.

**Request:**

```typescript
interface NuGetInstallParams {
    projectPath: string;     // Absolute path to .csproj/.fsproj
    packageId: string;
    version: string;
}
```

**Response:**

```typescript
interface NuGetInstallResponse {
    success: boolean;
    message: string;         // Human-readable result or error
}
```

**Behavior:**
- Executes `dotnet add <projectPath> package <packageId> --version <version>`
- On success, triggers sidecar workspace reload (project file changed)

### 3.5 `forge/nuget/uninstall`

Remove a NuGet package from a project.

**Request:**

```typescript
interface NuGetUninstallParams {
    projectPath: string;     // Absolute path to .csproj/.fsproj
    packageId: string;
}
```

**Response:**

```typescript
interface NuGetUninstallResponse {
    success: boolean;
    message: string;
}
```

**Behavior:**
- Executes `dotnet remove <projectPath> package <packageId>`
- On success, triggers sidecar workspace reload

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
- **NO** activity bar (VS Code provides one)
- **NO** status bar (VS Code provides one)
- **NO** decorative buttons without real handlers

### 4.2 Layout Structure

The panel renders only what's inside the editor area. Activity bar and
status bar shown below are **VS Code's own chrome** — drawn here for
orientation only, NOT part of the panel.

```
[VS Code activity bar — NOT part of panel]
+----------------------------------------------------------+
| Header: [logo] [Browse|Installed]   [search] [refresh]   |   ← panel starts
+---------------------------+------------------------------+
| Package List              | Details Panel               |
|                           |                              |
| [Package Item]            | [Header]                     |
| [Package Item] (selected) | [Install/Version]            |
| [Package Item]            | [Description]                |
| [Package Item]            | [Info Grid]                  |
|                           | [Tags]                       |
+---------------------------+------------------------------+   ← panel ends
[VS Code status bar — NOT part of panel]
```

### 4.3 Extension Responsibilities

The extension is responsible ONLY for:
1. Creating and managing the webview panel lifecycle
2. Rendering HTML/CSS/JS for the UI
3. Forwarding webview messages to LSP custom requests
4. Displaying LSP responses in the webview

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
  -> extension sends LSP request: forge/nuget/install { projectPath, packageId, version }
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

| Operation | Target | Method |
|-----------|--------|--------|
| Search | < 500ms p95 | HTTP GET with 60s cache |
| List installed | < 2s | `dotnet list` (cold), cached after first call |
| Install package | < 10s | `dotnet add` (depends on restore) |
| Remove package | < 5s | `dotnet remove` |
| Version list | < 500ms | HTTP GET with 5min cache |

## 7. Testing

### 7.1 Rust LSP Host Tests (E2E)

- [ ] `forge/nuget/search` returns packages for known query
- [ ] `forge/nuget/search` with empty query returns popular packages
- [ ] `forge/nuget/search` marks installed packages correctly
- [ ] `forge/nuget/versions` returns version list for known package
- [ ] `forge/nuget/installed` returns installed packages for test project
- [ ] `forge/nuget/install` adds package to test project
- [ ] `forge/nuget/uninstall` removes package from test project
- [ ] Error handling: invalid project path returns error
- [ ] Error handling: nonexistent package returns error

### 7.2 Extension Tests (VSIX)

- [ ] NuGet browser panel opens from command
- [ ] Panel reuses existing instance (singleton)
- [ ] Panel sends correct LSP request for search
- [ ] Panel sends correct LSP request for install
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
