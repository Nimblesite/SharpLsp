# SLNX Support Plan

**Status:** Implemented with one deferred follow-up
**Last Updated:** 2026-04-26
**Related specs:** `docs/specs/SHARPLSP-SPEC.md`, `docs/specs/SOLUTION-EXPLORER-SPEC.md`, `docs/specs/RIDER-PLUGIN-SPEC.md`

## Goal

Make `.slnx` a first-class solution format everywhere SharpLsp accepts, discovers,
loads, watches, renders, or passes through a solution file. `.sln` and `.slnx`
must have the same user-visible behavior: semantic features, diagnostics,
Solution Explorer, explicit solution selection, editor activation, and project
reload should all work from either format.

The implementation must not add another hand-written solution-file parser.
Microsoft publishes the official shared model and serializers in
`Microsoft.VisualStudio.SolutionPersistence`; SharpLsp should use that model for
solution-file structure and keep Rust focused on LSP routing and tree-sitter
symbol extraction.

## Sources Read

- `https://github.com/microsoft/vs-solutionpersistence`
  - Official serializers and object model for legacy `.sln` and XML `.slnx`.
  - Entry point is `SolutionSerializers`, including extension-based serializer
    selection through `GetSerializerByMoniker`.
  - `SolutionModel` contains `SolutionProjectModel` and `SolutionFolderModel`.
  - `.slnx` is XML, smaller, and designed to preserve user elements, comments,
    and whitespace when saved.
- `https://github.com/microsoft/vs-solutionpersistence/wiki/Samples`
  - Shows `SolutionSerializers.GetSerializerByMoniker(filePath)` then
    `serializer.OpenAsync(filePath, cancellationToken)`.
  - Shows conversion from `.sln` to `.slnx` via `SolutionSerializers.SlnXml.SaveAsync`.
  - Shows iterating `solution.SolutionProjects` and reading
    `SolutionProjectModel.FilePath`.
- `https://github.com/microsoft/vs-solutionpersistence/blob/main/SolutionPersistence.slnx`
  - Real `.slnx` shape uses `<Solution>`, nested `<Folder Name="/.../">`,
    `<Project Path="...csproj" />`, and `<File Path="..." />`.
- `https://devblogs.microsoft.com/visualstudio/new-simpler-solution-file-format/`
  - `.slnx` is XML, concise, comment/whitespace preserving, and intentionally
    lists project locations directly rather than supporting globs.
  - Minimum tooling for builds: .NET SDK `9.0.200` or Visual Studio/Build Tools
    `17.13+`; Visual Studio feature is stable in `17.14`.
  - Microsoft recommends avoiding side-by-side `.sln` and `.slnx` unless a team
    has an explicit sync/migration strategy.
- `https://devblogs.microsoft.com/dotnet/introducing-slnx-support-dotnet-cli/`
  - `dotnet sln migrate`, `dotnet build <file>.slnx`, `dotnet sln <file>.slnx add`,
    `list`, and `remove` are supported from .NET SDK `9.0.200`.
  - CLI commands are ambiguous when a directory contains both `.sln` and `.slnx`;
    callers should pass the exact file path.
- `https://www.nuget.org/packages/Microsoft.VisualStudio.SolutionPersistence/`
  - Current researched package version is `1.0.52`.
  - Package targets `net8.0` and `net472`; SharpLsp sidecars target `net10.0`, so
    the package is compatible.

## Starting SharpLsp State Before This Plan

SharpLsp already had partial `.slnx` support in the C# sidecar:

- `sidecars/SharpLsp.Sidecar.CSharp/Workspace/SolutionLoader.cs` discovers
  `.slnx` alongside `.sln`.
- `sidecars/SharpLsp.Sidecar.CSharp/Workspace/WorkspaceManager.cs` routes `.slnx`
  through `MSBuildWorkspace.OpenSolutionAsync`.
- `sidecars/SharpLsp.Sidecar.CSharp.Tests/SolutionLoaderTests.cs` covers `.slnx`
  discovery cases.
- `sidecars/SharpLsp.Sidecar.CSharp.Tests/WorkspaceManagerTests.cs` covers opening
  a minimal `.slnx` and recursively discovering one.

The initial gaps were wider than the sidecar loader:

- `editors/vscode/src/solution.ts` only discovers `**/*.sln`, strips only the
  `.sln` suffix, and shows `.sln`-only messages.
- `editors/vscode/package.json` only activates on `workspaceContains:**/*.sln`
  for solution files.
- `src/workspace_symbols.rs` parses legacy `.sln` text with line splitting and
  cannot read `.slnx`; this breaks `sharplsp/workspaceSymbols` and the Solution
  Explorer tree for `.slnx`.
- `sidecars/SharpLsp.Sidecar.FSharp/FSharpWorkspace.fs` treats `workspace/open`
  as a directory scan for the first `.fsproj`; explicit `.sln` or `.slnx` paths
  do not load the F# project set from the selected solution.
- Rider and Zed extension code and docs say `.sln` only. Rider default discovery
  and VFS refresh omit `.slnx`; Zed's slash command parser handles only legacy
  `.sln`.
- Specs and plans describe `.sln` as the solution format in several places.
- File watching and test fixtures are uneven: `.slnx` changes do not refresh
  the same surfaces as `.sln` changes, and end-to-end coverage is mostly `.sln`.

## Design

### Solution File Contract

SharpLsp will treat a "solution file" as either:

- legacy `.sln`
- XML `.slnx`

When both formats exist, SharpLsp must not silently choose one from a directory if
the choice is ambiguous. Editor selection and `sharplsp/loadSolution` must pass the
exact chosen file path into the host and sidecars. This matches .NET CLI behavior
and prevents stale or wrong solution loads during migration periods.

`.slnf` remains out of scope for this plan except that the design should not
block later `.slnf` support. Microsoft documents solution filters as still tied
to a concrete `.sln` or `.slnx` file.

### Authoritative Solution Model

Add a small solution-model API to the sidecar layer, backed by
`Microsoft.VisualStudio.SolutionPersistence`.

Proposed IPC method:

| Method | Request | Response |
|---|---|---|
| `solution/read` | `{ path: string }` | `SolutionFileModel` |

`SolutionFileModel` should be a neutral DTO owned by `SharpLsp.Sidecar.Common`:

```csharp
public sealed record SolutionFileModel(
    string Path,
    string Format,
    IReadOnlyList<SolutionProjectEntry> Projects,
    IReadOnlyList<SolutionFolderEntry> Folders,
    IReadOnlyList<SolutionItemEntry> Files);
```

Project entries should include at least:

- display name
- absolute project path
- original relative path
- project type or extension
- stable solution identity if the model exposes one
- parent solution folder path/name when present
- declaration order

Folder entries should preserve solution-folder hierarchy independently from
physical directories. `.slnx` folder names can be slash-delimited paths such as
`/src/`; the DTO should expose normalized parent/child relationships so editor
clients do not need to parse folder syntax.

Use `SolutionSerializers.GetSerializerByMoniker(path)` for both `.sln` and
`.slnx`. Unsupported extensions return a structured error. Syntax errors return
a structured error without crashing the sidecar.

### Rust Host Changes

`sharplsp/workspaceSymbols` should stop owning solution-file parsing. It should:

1. Deserialize `WorkspaceSymbolsParams.solution`.
2. Ask `solution/read` for the selected solution model.
3. Iterate the returned `.csproj` and `.fsproj` project paths in declaration
   order.
4. Keep the existing tree-sitter source scan and symbol extraction.
5. Return the same `WorkspaceSymbolsResponse`, extended only where necessary
   for solution folders.

This keeps one solution parser for `.sln` and `.slnx`. It also removes the
current legacy `.sln` line parser from the long-term path.

The practical Rust API change is to pass the runtime and a solution-model
sidecar into `handle_workspace_symbols`, similar to existing semantic handlers
that use `runtime.block_on(sidecar.request(...))`.

### Sidecar Workspace Loading

C#:

- Keep the existing `MSBuildWorkspace.OpenSolutionAsync` route for `.slnx`.
- Add direct `Microsoft.VisualStudio.SolutionPersistence` package reference so
  the solution-model API does not rely on a transitive Roslyn/MSBuild dependency.
- Add structured logs for selected solution path, format, project count, and
  warnings from the serializer/model reader.

F#:

- Change `workspace/open` to accept explicit `.sln` and `.slnx` paths.
- Use the same solution-model API or a shared helper to extract `.fsproj`
  entries from the chosen solution.
- Load the selected `.fsproj` set instead of scanning the first recursive
  `.fsproj`.
- If multi-project F# remains incomplete, stage this honestly:
  first load the single selected `.fsproj` from a one-project solution, then
  expand state to support multiple `FSharpProjectOptions`.

### VS Code Extension Changes

- Activate on `workspaceContains:**/*.slnx`.
- Discover both `**/*.sln` and `**/*.slnx`.
- Display exact filenames in QuickPick labels so `App.sln` and `App.slnx` are
  visibly different.
- Update `.sln`-only messages, welcome text, comments, and state names to
  "solution file" or `.sln/.slnx`.
- Pass the selected exact path through `sharplsp/loadSolution` unchanged.
- Ensure tree refresh and project dependency watchers include `.slnx` where
  solution reload is expected.
- Update scaffolding paths that search for a solution file before calling
  `dotnet sln ... add`; use the exact selected file and rely on the .NET SDK
  to mutate `.slnx`.

### Rider And Zed Changes

Rider:

- Default discovery should include `.slnx`.
- VFS refresh should include `.slnx`.
- User-facing labels should say `.sln/.slnx` or "solution".
- `sharplsp/loadSolution` and `sharplsp/workspaceSymbols` already accept a path; keep
  the exact path selected by the IDE.

Zed:

- Slash command help and completion should mention `.slnx`.
- Prefer routing `/sharplsp-tree` through the LSP `sharplsp/workspaceSymbols` once Zed
  exposes client access from slash commands.
- Until then, add a read-only XML parser for `.slnx` only if the Zed WASM
  sandbox prevents calling the sidecar. This parser must use a real XML parser
  dependency that works under `wasm32-wasip1`, not line splitting.

### Tests

Coverage must be end-to-end where possible and use real `.slnx`, `.csproj`, and
`.fsproj` files.

Required coverage:

- `solution/read` reads legacy `.sln` and `.slnx` into equivalent DTOs.
- `solution/read` preserves project declaration order.
- `.slnx` with nested `<Folder>` elements maps projects to solution folders.
- `.slnx` with `<File>` solution items does not create project nodes.
- `.slnx` with `<Configurations>` still returns projects without requiring the
  host to understand configuration defaults.
- C# sidecar opens an explicit `.slnx` and semantic requests work afterward.
- F# sidecar opens an explicit `.slnx` containing `.fsproj`.
- `sharplsp/workspaceSymbols` returns project/symbol hierarchy from a real `.slnx`.
- VS Code discovers one `.slnx`, multiple `.slnx`, and mixed `.sln` plus `.slnx`.
- VS Code sends the exact selected `.slnx` path to `sharplsp/loadSolution`.
- Rider default discovery and refresh include `.slnx`.
- Zed slash command accepts `.slnx` if local parsing remains in that extension.

## Rollout

### Phase 1 - Solution Model API

Implement `solution/read` in the sidecar layer using
`Microsoft.VisualStudio.SolutionPersistence`, with DTOs in
`SharpLsp.Sidecar.Common` and focused sidecar tests.

### Phase 2 - Rust Workspace Symbols

Route `sharplsp/workspaceSymbols` through `solution/read`, then delete or
deprecate the manual `.sln` parser path in `src/workspace_symbols.rs`.

### Phase 3 - Editor Discovery

Update VS Code, Rider, and Zed discovery, activation, refresh, labels, and tests
so all editor surfaces recognize `.slnx`.

### Phase 4 - F# Workspace Loading

Make the F# sidecar respect explicit `.sln/.slnx` selections and load the F#
project set from the selected solution model.

### Phase 5 - Spec And Documentation Cleanup

Update solution-related specs, user docs, and examples to say `.sln/.slnx`
where both are supported. Keep `.slnx` limitations explicit.

## TODO

- [x] Update `docs/specs/SHARPLSP-SPEC.md` project-system text to say `.sln/.slnx`.
- [x] Update `docs/specs/SOLUTION-EXPLORER-SPEC.md` request examples and architecture diagram for `.sln/.slnx`.
- [x] Add `Microsoft.VisualStudio.SolutionPersistence` direct package reference to the sidecar project that owns solution parsing.
- [x] Add `SolutionFileModel`, `SolutionProjectEntry`, `SolutionFolderEntry`, and `SolutionItemEntry` DTOs in `SharpLsp.Sidecar.Common`.
- [x] Implement `solution/read` using `SolutionSerializers.GetSerializerByMoniker`.
- [x] Add sidecar tests for `.sln`, flat `.slnx`, nested-folder `.slnx`, solution-items `.slnx`, and malformed `.slnx`.
- [x] Change `src/main.rs` and `src/workspace_symbols.rs` so `sharplsp/workspaceSymbols` requests the sidecar solution model.
- [x] Remove or quarantine the manual legacy `.sln` parser in `src/workspace_symbols.rs`.
- [x] Add Rust E2E coverage for `sharplsp/workspaceSymbols` against a real `.slnx`.
- [x] Update VS Code activation events to include `workspaceContains:**/*.slnx`.
- [x] Update VS Code solution discovery to find both `.sln` and `.slnx`.
- [x] Update VS Code messages, welcome text, comments, and state names from `.sln`-only wording to solution-file wording.
- [x] Add VS Code tests for single `.slnx`, multiple `.slnx`, and mixed `.sln` plus `.slnx` selection.
- [x] Include `.slnx` in VS Code solution/project refresh watchers where solution reload is expected.
- [x] Update VS Code scaffolding solution lookup to use selected `.sln/.slnx` paths.
- [x] Update Rider default solution discovery to include `.slnx`.
- [x] Include `.slnx` in Rider VFS refresh triggers.
- [x] Update Rider `.sln`-only UI text to `.sln/.slnx` or "solution".
- [x] Update Zed slash command help/completion to mention `.slnx`.
- [x] Add a Zed `.slnx` parsing path only if the extension cannot call SharpLsp LSP for `sharplsp/workspaceSymbols`.
- [x] Fix F# sidecar `workspace/open` so explicit `.sln` and `.slnx` paths load `.fsproj` entries from the selected solution.
- [x] Add F# sidecar tests for explicit `.slnx` with one `.fsproj`.
- [ ] Add mixed C#/F# `.slnx` full-stack coverage after F# multi-project loading is ready.
- [x] Verify `dotnet build <solution>.slnx` in CI fixtures uses SDK `9.0.200+` or skip with a clear version guard.

Deferred note: mixed C#/F# full-stack `.slnx` coverage remains gated on the
F# sidecar moving from single-project state to multi-project workspace state.
Current CI and release workflows use `actions/setup-dotnet` with `10.0.x`, which
satisfies the `.slnx` CLI minimum of SDK `9.0.200`.
