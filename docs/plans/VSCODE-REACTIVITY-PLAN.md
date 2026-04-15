# VSCode Reactivity Plan

Implementation plan tracking the reactive-UI rollout described in [docs/specs/VSCODE-REACTIVITY-SPEC.md](../specs/VSCODE-REACTIVITY-SPEC.md).

## Phase 1 — Foundation (done)

- [x] Extend [signals.ts](../../editors/vscode/src/signals.ts) with an `effect()` helper that auto-tracks Signal reads.
- [x] Create [project-deps-store.ts](../../editors/vscode/src/project-deps-store.ts) with a `projectDependencies: Signal<Map<string, ProjectDependencies>>` and a FileSystemWatcher covering `**/{*.csproj,*.fsproj,Directory.Packages.props}`.
- [x] Wire `initProjectDepsStore(context)` into [extension.ts](../../editors/vscode/src/extension.ts) `activate()`.

## Phase 2 — Migrate surfaces (done)

- [x] `SolutionExplorerProvider` subscribes to `projectDependencies`; `buildDependencyFolder` reads from the signal via `ensureTracked`.
- [x] `NuGetBrowserPanel` subscribes to `projectDependencies` and reloads installed packages on change. Project paths are registered via `ensureTracked` during `initialLoad`.
- [x] Unify package-row rendering: installed tab now calls `buildPackageItem` via `hydrateInstalledRow` instead of its own inline HTML. `packageIconImg(pkg)` is the single icon-overlay renderer used by list rows and the details header.
- [x] Installed tab gets real icons via new `fetchInstalledMetadata` helper (batch `packageid:` lookup).

## Phase 3 — Tests (done)

- [x] `panel reacts to external csproj edit (package removed)` — [nuget-browser.test.ts](../../editors/vscode/src/test/suite/nuget-browser.test.ts)
- [x] `panel reacts to external csproj edit (package added)`
- [x] `details panel renders package icon image when iconUrl present`
- [x] `installed tab renders icons (no DRY violation)`
- [x] `Dependencies → Packages tree reacts to external csproj edit` — [solution-explorer.test.ts](../../editors/vscode/src/test/suite/solution-explorer.test.ts)

## Phase 4 — Follow-ups (pending)

- [ ] Replace `parseProjectDependencies` RegEx with a real XML parser (CLAUDE.md: "Avoid RegEx… Always use ACTUAL parsers"). Tracked separately — reactivity change is orthogonal.
- [ ] Audit status-bar and code-lens surfaces for the same reactive contract.
- [ ] Server-push channel for `forge/nuget/installedChanged` so the Rust side can notify clients after MSBuild reloads without every client re-reading the csproj. Current client-side FSW is sufficient but duplicates work across editors.
- [ ] Migrate existing manual `onDidChangeEmitter.fire(undefined)` call-sites in `tree.ts` to pure signal writes where possible.

## Known issues flagged by this work

- `parseProjectDependencies` in [dependencies.ts](../../editors/vscode/src/dependencies.ts) uses RegEx. This predates the rule in CLAUDE.md. Flagged in Phase 4.
