# Package Maintenance Plan

Implementation plan for [PACKAGE-MAINTENANCE-SPEC](../specs/PACKAGE-MAINTENANCE-SPEC.md).
Build order is bottom-up: pure Rust logic + mapping (unit-testable) → sidecar
detection → host request wiring → VS Code UI → e2e tests.

## Reuse map (do NOT reinvent)

| Need | Existing code |
|---|---|
| Add/remove `PackageReference`/`PackageVersion` (trivia-preserving) | `src/nuget/xml_edit.rs` |
| Enumerate projects + props, detect CPM | `src/nuget/targets.rs` |
| `dotnet list` / background restore | `src/nuget/cli.rs`, `nuget::handlers` |
| Find ancestor `Directory.Packages.props` | `nuget::handlers::find_packages_props` |
| Per-id removal + restore | `sharplsp/nuget/uninstall` |
| Sidecar request/response pattern | `MessageRouter.Register`, `SidecarManager::request` |
| Context-menu command pattern | `registerContextMenuCommands` in `extension.ts` |

## TODO

- [x] [PKG-CONSOLIDATE-SCAN]/[PKG-CONSOLIDATE-APPLY] `src/nuget/consolidate.rs` —
      scan shared packages, hoist to `Directory.Build.props`, CPM-aware, reuse
      `xml_edit`/`targets`. Unit tests over temp solutions + dry-run mode.
- [x] [PKG-UNUSED-MAP] assembly-path → package-id pure fn (`src/nuget/unused.rs`),
      8 unit tests (analyzer-skip, transitive-skip, case-insensitive, win paths).
- [x] [PKG-UNUSED-DETECT-CS] C# sidecar `project/unusedPackages` via
      `GetUsedAssemblyReferences` (`WorkspaceManager.Packages.cs`).
- [x] [PKG-UNUSED-DETECT-FS] F# sidecar `project/unusedPackages` via assets.json
      refs + FCS `GetAllUsesOfAllSymbols` (`FSharpPackages.fs`, isolated, fail-safe).
- [x] [PKG-UNUSED-REQUEST]/[PKG-CONSOLIDATE-REQUEST] host handlers
      `sharplsp/nuget/unused` + `sharplsp/nuget/consolidate`, dispatch in
      `main.rs`, sidecar routing by extension.
- [x] [PKG-UNUSED-UI]/[PKG-CONSOLIDATE-UI] commands + `view/item/context`
      entries (project + solution), `package.json` + nls (en/ja/zh-cn),
      `package-maintenance.ts` + `extension.ts`.
- [x] Tests: Rust unit (mapping + consolidate); VS Code e2e in
      `context-menus.test.ts` (registration, when-clauses, `collectProjectPaths`,
      graceful no-path, real-LSP consolidate dry-run + apply).
- [x] Deslop `rescan` + `top-offenders`: no new clusters in the feature files;
      clippy/fmt/eslint/tsc green; Rust + both sidecars build clean.

## Dedup notes

- Extracted shared `src/nuget/parse.rs` (`read_package_items`, `extract_attr`);
  removed the duplicate `extract_attr` + `list_props_packages` body from `handlers.rs`.
- Moved `find_packages_props` into `targets.rs` (was private in `handlers.rs`).
- Made `FSharpWorkspace.parseFsprojSourceFiles` + new `frameworkReferenceArgs`
  `internal` and reused them from `FSharpPackages.fs` (no copy).
- Removal reuses `dependencies.removeNuGetPackage`; the C#/F# sidecars return raw
  paths so the path→package mapping exists once, in Rust.
