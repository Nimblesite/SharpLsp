# VSCode Extension Reactivity Spec

**Status:** active
**Owner:** VSCode extension (`editors/vscode/src/`)
**Invariant (CLAUDE.md):** _"All screens MUST BE 100% reactive. If underlying data changes, the screen must be listening and update accordingly."_

---

## 1. Goal

Every UI surface in the SharpLsp VSCode extension — webview panels, tree views, status bars, code lenses — must be a **pure projection of reactive state**. When the underlying data changes (whether by user action, LSP notification, file-system event, or another tool editing files on disk), **every surface reading that data must update automatically**, with no explicit refresh call from the user or from Claude.

A UI surface that requires the user to click Refresh, reopen a panel, or toggle focus to see current data is **broken** and must be fixed.

## 2. Signal Primitives

The extension uses a single in-repo reactive primitive: the `Signal<T>` class in [editors/vscode/src/signals.ts](../../editors/vscode/src/signals.ts). No external dependency (Preact Signals, alien-signals, SolidJS) is introduced — the native primitive is sufficient and keeps the bundle small.

### Signal<T>

```ts
class Signal<T> {
  get value(): T               // read, auto-tracked inside effect()
  set value(next: T)           // write; Object.is equality skips no-op updates
  subscribe(fn): () => void    // manual subscription, returns a disposer
  notify(): void               // force-notify listeners (for in-place mutable updates)
}
```

### effect(fn)

```ts
function effect(fn: () => void): () => void
```

Runs `fn` once, tracks every `Signal.value` read during the call, and re-runs `fn` whenever any tracked signal changes. Returns a disposer. Re-runs re-track dependencies (conditional reads are handled correctly).

Use `effect()` for UI rendering code that reads multiple signals. Use `subscribe()` for imperative side-effects driven by a single signal.

## 3. Source-of-Truth Signals

The extension maintains these **global signals** (module-level exports). Every UI surface that needs the data reads it from these, never from a local cache.

| Signal | Module | Purpose |
|--------|--------|---------|
| `client` | [state.ts](../../editors/vscode/src/state.ts) | Active LSP LanguageClient |
| `solutionPath` | [state.ts](../../editors/vscode/src/state.ts) | Absolute path of the loaded `.sln` or `.slnx` file |
| `symbolsState` | [state.ts](../../editors/vscode/src/state.ts) | `empty \| loaded \| error` union of workspace symbols |
| `sortOrder` | [state.ts](../../editors/vscode/src/state.ts) | Solution Explorer sort cycle |
| `projectDependencies` | [project-deps-store.ts](../../editors/vscode/src/project-deps-store.ts) | `Map<projectPath, ProjectDependencies>` — PackageReferences & ProjectReferences per csproj/fsproj |

New source-of-truth state must be added to one of these modules (or a new peer module). It **must not** be shadowed by a local field in a UI component — UI components read signals directly.

## 4. File-System Watchers Drive Derived State

State derived from files on disk is refreshed by a `vscode.workspace.createFileSystemWatcher` whose change events write to the corresponding signal. There is **no polling**, and the user never has to trigger a refresh manually.

### Project-dependencies watcher

Registered once during `activate()` by [project-deps-store.ts](../../editors/vscode/src/project-deps-store.ts) on the glob:

```
**/{*.csproj,*.fsproj,Directory.Packages.props}
```

- `onDidChange` → debounce 150 ms → re-parse the affected project → update `projectDependencies`
- `onDidCreate` → same
- `onDidDelete` → remove the entry
- Directory.Packages.props changes → rescan every tracked project

### Contract: after any external csproj/fsproj write, every surface that reads `projectDependencies` re-renders within ~200 ms (debounce + VSCode FSW latency).

## 5. UI Surfaces and Their Subscriptions

### 5.1 Solution Explorer tree — [tree.ts](../../editors/vscode/src/tree.ts)

`SolutionExplorerProvider` subscribes to:
- `symbolsState` → full rebuild
- `sortOrder` → full rebuild
- `projectDependencies` → full rebuild

The tree's Dependencies → Packages node reads the parsed package list from `projectDependencies.value.get(projectPath)`. **It does NOT call `parseProjectDependencies` directly.** The file watcher is the only code path that calls the parser.

### 5.2 NuGet Browser panel — [nuget-browser.ts](../../editors/vscode/src/nuget-browser.ts)

`NuGetBrowserPanel` subscribes to:
- `projectDependencies` → reload installed packages via LSP (picks up external csproj edits)

The Install/Remove button label is driven by the csproj content as surfaced through `projectDependencies` plus the LSP's `sharplsp/nuget/installed` response. Editing the csproj on disk must flip the button without any user action.

## 6. DRY: one renderer, one icon

Identical visual elements must be rendered by a **single function**. Specifically:

- Every package row (Browse tab, Installed tab, details panel header) uses the same icon box structure, with the same `packageIconImg(pkg)` helper rendering the iconUrl `<img>` overlay. Duplicated inline HTML for the same visual element is forbidden.
- When a surface needs the same data shape as another (e.g. the Installed tab rendering the same row as Browse), the data is hydrated into the common shape (`NuGetSearchResult`) and passed to the single renderer.

## 7. Required Tests (non-negotiable)

Every reactive surface must have an e2e test that:
1. Opens the surface with a known initial state.
2. Mutates the underlying source (file on disk, LSP state, etc.) _without calling any refresh API_.
3. Polls the surface and asserts the new state appears within a timeout.

Current coverage:

| Surface | Test | File |
|---------|------|------|
| NuGet panel — Remove → Install on csproj edit | `panel reacts to external csproj edit (package removed)` | [nuget-browser.test.ts](../../editors/vscode/src/test/suite/nuget-browser.test.ts) |
| NuGet panel — Install → Remove on csproj edit | `panel reacts to external csproj edit (package added)` | [nuget-browser.test.ts](../../editors/vscode/src/test/suite/nuget-browser.test.ts) |
| NuGet details panel icon | `details panel renders package icon image when iconUrl present` | [nuget-browser.test.ts](../../editors/vscode/src/test/suite/nuget-browser.test.ts) |
| NuGet installed tab icons (DRY) | `installed tab renders icons (no DRY violation)` | [nuget-browser.test.ts](../../editors/vscode/src/test/suite/nuget-browser.test.ts) |
| Solution Explorer packages node | `Dependencies → Packages tree reacts to external csproj edit` | [solution-explorer.test.ts](../../editors/vscode/src/test/suite/solution-explorer.test.ts) |

## 8. Anti-patterns (illegal)

- **Caching data that has a reactive source** in a local field. If `projectDependencies` has the data, read it directly every render.
- **Calling a parser or disk read from a UI component.** Only the watcher/store module does that.
- **Exposing a manual Refresh button** as the primary way to sync state. Refresh buttons may exist as a user escape hatch; they must not be the load-bearing update mechanism.
- **Duplicated inline HTML for the same visual element.** Extract a helper.
- **Diverging representations** of the same data (e.g. a bespoke installed-row renderer alongside the main package-row renderer).
- **Snapshotting derived state into a stored object.** Example: storing `selectedPackage` with an `isInstalled` boolean baked in at selection time. The snapshot becomes stale the moment the underlying data changes. **Always derive boolean flags, version strings, and other derived fields from the live source-of-truth signal at render time.** The renderer is the only correct place to compute "is this package currently installed" — never the selection handler.
