# VSCode Extension Reactivity Spec `[VSCODE-REACTIVITY]`

**Status:** active · **Owner:** VSCode extension (`src/editors/vscode/src/`) · **Invariant (CLAUDE.md):** _"All screens MUST BE 100% reactive. If underlying data changes, the screen must be listening and update accordingly."_

---

## Goal `[VSCODE-REACTIVITY-GOAL]`

Every webview, tree view, status bar, and code lens MUST be a projection of reactive state. A user action, LSP notification, file-system event, or external disk edit MUST update every dependent surface automatically; correctness MUST NOT depend on Refresh, reopening a panel, or changing focus.

## Signal Primitives `[VSCODE-REACTIVITY-SIGNALS]`

The extension uses the in-repo `Signal<T>` primitive in [`signals.ts`](../../src/editors/vscode/src/signals.ts); no external signal library is introduced.

### Signal<T> `[VSCODE-REACTIVITY-SIGNALS-VALUE]`

```ts
class Signal<T> {
  get value(): T               // read, auto-tracked inside effect()
  set value(next: T)           // write; Object.is equality skips no-op updates
  subscribe(fn): () => void    // manual subscription, returns a disposer
  notify(): void               // force-notify listeners (for in-place mutable updates)
}
```

### effect(fn) `[VSCODE-REACTIVITY-SIGNALS-EFFECT]`

```ts
function effect(fn: () => void): () => void
```

Runs `fn` once, tracks every `Signal.value` read during the call, and re-runs `fn` whenever any tracked signal changes. Returns a disposer. Re-runs re-track dependencies (conditional reads are handled correctly).

Use `effect()` for UI rendering code that reads multiple signals. Use `subscribe()` for imperative side-effects driven by a single signal.

## Source-of-Truth Signals `[VSCODE-REACTIVITY-STATE]`

The extension maintains these **global signals** (module-level exports). Every UI surface that needs the data reads it from these, never from a local cache.

| Signal | Module | Purpose |
|--------|--------|---------|
| `client` | [state.ts](../../src/editors/vscode/src/state.ts) | Active LSP LanguageClient |
| `solutionPath` | [state.ts](../../src/editors/vscode/src/state.ts) | Absolute path of the loaded `.sln` or `.slnx` file |
| `dotnetPath` | [state.ts](../../src/editors/vscode/src/state.ts) | Resolved .NET executable path |
| `symbolsState` | [state.ts](../../src/editors/vscode/src/state.ts) | `empty \| loaded \| error` union of workspace symbols |
| `sortOrder` | [state.ts](../../src/editors/vscode/src/state.ts) | Solution Explorer sort cycle |
| `projectDependencies` | [project-deps-store.ts](../../src/editors/vscode/src/project-deps-store.ts) | Authoritative `Map<projectPath, ProjectDependencies>` state for PackageReferences and ProjectReferences; not memoization |

New source-of-truth state MUST live in one of these modules or a peer store and MUST NOT be shadowed in a UI field. Derived flags and version strings, including package installation state, MUST be computed from live signals during rendering rather than stored in selection snapshots.

## File-System Watchers Drive Derived State `[VSCODE-REACTIVITY-WATCHERS]`

State derived from disk is refreshed by [`project-deps-store.ts`](../../src/editors/vscode/src/project-deps-store.ts) watchers whose events write to the corresponding signal. A 250 ms mtime guard MAY cover missed events for already tracked projects; it MUST NOT replace event-driven updates or require manual refresh.

### Project-dependencies Watcher `[VSCODE-REACTIVITY-WATCHERS-PROJECTS]`

Registered once during `activate()` by [project-deps-store.ts](../../src/editors/vscode/src/project-deps-store.ts) on the glob:

```
**/{*.csproj,*.fsproj,Directory.Packages.props}
```

- `onDidChange` → debounce 150 ms → re-parse the affected project → update `projectDependencies`
- `onDidCreate` → same
- `onDidDelete` → remove the entry
- Directory.Packages.props changes → rescan every tracked project

### Update Latency `[VSCODE-REACTIVITY-WATCHERS-LATENCY]`

After an external `.csproj` or `.fsproj` write, every surface that reads `projectDependencies` MUST re-render within approximately 200 ms on the watcher path, including the 150 ms debounce, or within 400 ms when the 250 ms mtime guard detects a missed event.

## UI Surfaces and Their Subscriptions `[VSCODE-REACTIVITY-SURFACES]`

### Solution Explorer Tree `[VSCODE-REACTIVITY-SURFACES-TREE]`

Implementation: [`tree.ts`](../../src/editors/vscode/src/tree.ts).

`SolutionExplorerProvider` subscribes to:

- `symbolsState` → full rebuild
- `sortOrder` → full rebuild
- `projectDependencies` → full rebuild

The tree's Dependencies → Packages node reads `projectDependencies.value.get(projectPath)` and MUST NOT call `parseProjectDependencies` directly. Parsing and signal updates belong to the store's watcher, mtime-guard, and explicit rescan paths.

### NuGet Browser Panel `[VSCODE-REACTIVITY-SURFACES-NUGET]`

Implementation: [`nuget-browser.ts`](../../src/editors/vscode/src/nuget-browser.ts).

`NuGetBrowserPanel` subscribes to:

- `projectDependencies` → reload installed packages via LSP (picks up external csproj edits)

The Install/Remove button label is driven by the csproj content as surfaced through `projectDependencies` plus the LSP's `sharplsp/nuget/installed` response. Editing the csproj on disk MUST flip the button without any user action.

## Shared Rendering `[VSCODE-REACTIVITY-RENDERING]`

Identical visual elements MUST use one renderer:

- Every package row (Browse tab, Installed tab, details panel header) uses the same icon box structure, with the same `packageIconImg(pkg)` helper rendering the iconUrl `<img>` overlay. Duplicated inline HTML for the same visual element is forbidden.
- When a surface needs the same data shape as another (e.g. the Installed tab rendering the same row as Browse), the data is hydrated into the common shape (`NuGetSearchResult`) and passed to the single renderer.

## Required Tests `[VSCODE-REACTIVITY-TESTING]`

Every reactive surface MUST have an end-to-end test that:

1. Opens the surface with a known initial state.
2. Mutates the underlying source (file on disk, LSP state, etc.) _without calling any refresh API_.
3. Polls the surface and asserts the new state appears within a timeout.

Current coverage:

| Surface | Test | File |
|---------|------|------|
| NuGet panel — Remove → Install on csproj edit | `panel reacts to external csproj edit (package removed)` | [nuget-browser.test.ts](../../src/editors/vscode/src/test/suite/nuget-browser.test.ts) |
| NuGet panel — Install → Remove on csproj edit | `panel reacts to external csproj edit (package added)` | [nuget-browser.test.ts](../../src/editors/vscode/src/test/suite/nuget-browser.test.ts) |
| NuGet details panel icon | `details panel renders package icon image when iconUrl present` | [nuget-browser.test.ts](../../src/editors/vscode/src/test/suite/nuget-browser.test.ts) |
| NuGet installed tab icons (DRY) | `installed tab renders icons (no DRY violation)` | [nuget-browser.test.ts](../../src/editors/vscode/src/test/suite/nuget-browser.test.ts) |
| Solution Explorer packages node | `Dependencies → Packages tree reacts to external csproj edit` | [solution-explorer.test.ts](../../src/editors/vscode/src/test/suite/solution-explorer.test.ts) |
