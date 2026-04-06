# Solution Explorer Context Menus — Implementation Plan

**Spec:** [SOLUTION-EXPLORER-SPEC.md](../specs/SOLUTION-EXPLORER-SPEC.md)
**Status:** In Progress
**Last Updated:** 2026-04-07

## Overview

Add context menus to Solution Explorer tree nodes and file explorer for .NET solution management. Includes Sort Members, Copy Qualified Name, Copy Name, Reveal in File Explorer, Collapse All Children, Build, Rebuild, Run, Debug, Configure Args, and Solution Management (Add/Remove projects).

## Phase 1: Context Value Foundation

Set `contextValue` on all tree nodes so context menus can be scoped by node type.

- [x] Set `contextValue` on symbol nodes in `editors/vscode/src/tree.ts` based on symbol kind (see spec Context Value Mapping table)
- [x] Set `contextValue` on Solution, Project, and DependencyFolder nodes
- [x] Verify existing `nugetPackage` and `projectReference` context values still work

## Phase 2: Client-Side Context Menu Commands

Register commands that run entirely in the VS Code extension (no LSP round-trip needed).

- [x] Add command constants to `editors/vscode/src/constants.ts`
- [x] Add commands to `package.json` contributions:
  - `forge.copyQualifiedName` — Copy Qualified Name
  - `forge.copyName` — Copy Name
  - `forge.revealInExplorer` — Reveal in File Explorer
  - `forge.collapseChildren` — Collapse All Children
  - `forge.sortMembers` — Sort Members
- [x] Add `view/item/context` menu entries in `package.json` scoped by `viewItem`
- [x] Implement command handlers in `editors/vscode/src/extension.ts`:
  - `copyQualifiedName`: walk tree to build `Namespace.Type.Member`, copy to clipboard
  - `copyName`: copy node label (unqualified name) to clipboard
  - `revealInExplorer`: use `commands.executeCommand("revealInExplorer", uri)` on the symbol's file
  - `collapseChildren`: programmatic collapse via tree view API

## Phase 3: Sort Members — VS Code Extension

- [x] Add `forge.memberSortOrder` configuration schema to `package.json` with defaults (hierarchy, accessibilityOrder, categoryOrder)
- [x] Implement `forge.sortMembers` command handler:
  - Read `forge.memberSortOrder` from workspace config
  - Send `forge/sortMembers` custom LSP request with document URI, type range, and sort config
  - Apply returned `TextEdit[]` via `workspace.applyEdit`

## Phase 4: Sort Members — Rust LSP Handler

Implement the `forge/sortMembers` custom request in the Rust host.

- [x] Define `forge/sortMembers` request types (params: document URI, type range, sort config; result: `TextEdit[]`)
- [x] Register request handler in `src/main.rs`
- [x] Implement member sorting in a new `src/sort_members.rs` module:
  - Parse the type body using tree-sitter to identify member declarations
  - Extract each member's access modifier, kind (category), and name
  - Sort members according to the provided hierarchy config
  - Generate `TextEdit[]` that reorders the member declarations (preserve leading comments/attributes attached to each member)
- [x] Handle edge cases:
  - [x] Preserve blank lines between accessibility/category groups
  - [x] Keep `#region` / `#endregion` blocks intact
  - [x] Preserve comments/attributes attached to members (leading trivia)
  - [x] Handle partial classes (sort only the members in the selected type declaration)

## Phase 5: Build, Rebuild, Run, Debug Actions

Add .NET CLI integration for build and run operations.

### 5.1 Command Infrastructure

- [ ] Add command constants to `editors/vscode/src/constants.ts`:
  - `CMD_BUILD`, `CMD_REBUILD`, `CMD_RUN`, `CMD_DEBUG`
  - `CMD_CONFIGURE_BUILD_ARGS`, `CMD_CONFIGURE_RUN_ARGS`
- [ ] Add commands to `package.json`:
  - Titles: Build, Rebuild, Run, Debug, Configure Build Arguments..., Configure Run Arguments...
  - Icons: `$(debug-start)` for Run, `$(debug)` for Debug, `$(gear)` for configure
- [ ] Add `view/item/context` menu entries in `package.json`:
  - Build/Rebuild: `when: viewItem =~ /^(solution|project)$/`, group `2_build`
  - Run/Debug: `when: viewItem == project`, group `3_run`
  - Configure args: group `9_configure`

### 5.2 Configuration Schema

Add to `package.json` configuration:

```json
{
  "forge.build.extraArgs": {
    "type": "array",
    "items": { "type": "string" },
    "default": [],
    "description": "Extra arguments for dotnet build/rebuild"
  },
  "forge.run.extraArgs": {
    "type": "array",
    "items": { "type": "string" },
    "default": [],
    "description": "Extra arguments for dotnet run"
  },
  "forge.test.extraArgs": {
    "type": "array",
    "items": { "type": "string" },
    "default": [],
    "description": "Extra arguments for dotnet test"
  }
}
```

### 5.3 Task Execution Module

Create `editors/vscode/src/dotnet-commands.ts`:

- [ ] `runBuild(projectPath: string, extraArgs: string[]): Promise<void>` — execute `dotnet build`
- [ ] `runRebuild(projectPath: string, extraArgs: string[]): Promise<void>` — execute `dotnet rebuild`
- [ ] `runProject(projectPath: string, extraArgs: string[]): Promise<void>` — execute `dotnet run`
- [ ] `debugProject(projectPath: string, extraArgs: string[]): Promise<void>` — start debug session
- [ ] Use VS Code Task API for build/run operations
- [ ] Show progress notification during long operations
- [ ] Capture and display output in VS Code terminal

### 5.4 Argument Storage

Implement per-project argument storage in `editors/vscode/src/extension.ts`:

- [ ] Store format: `forge.buildArgs.${projectPath}` and `forge.runArgs.${projectPath}`
- [ ] `getBuildArgs(projectPath: string): string[]` — combine per-project + global args
- [ ] `getRunArgs(projectPath: string): string[]` — combine per-project + global args
- [ ] `configureBuildArgs(projectPath: string): Promise<void>` — input box for args
- [ ] `configureRunArgs(projectPath: string): Promise<void>` — input box for args

### 5.5 Command Handlers

Register handlers in `editors/vscode/src/extension.ts`:

- [ ] `forge.build` — get project path from node, get args, call `runBuild()`
- [ ] `forge.rebuild` — get project path from node, get args, call `runRebuild()`
- [ ] `forge.run` — get project path from node, get args, call `runProject()`
- [ ] `forge.debug` — get project path from node, get args, call `debugProject()`
- [ ] `forge.configureBuildArgs` — show input, store per-project args
- [ ] `forge.configureRunArgs` — show input, store per-project args

## Phase 6: Solution Management

Add/Remove projects from solutions.

### 6.1 Command Infrastructure

- [ ] Add command constants to `editors/vscode/src/constants.ts`:
  - `CMD_ADD_TO_SOLUTION`, `CMD_REMOVE_FROM_SOLUTION`
- [ ] Add commands to `package.json`:
  - Titles: Add to Solution, Remove from Solution
  - Icons: `$(add)` for Add, `$(remove)` for Remove

### 6.2 File Explorer Context Menu

Add to `package.json` `menus/explorer/context`:

```json
{
  "command": "forge.addToSolution",
  "when": "resourceExtname == .csproj || resourceExtname == .fsproj",
  "group": "2_solution@1"
}
```

### 6.3 Solution Explorer Context Menu

Add to `package.json` `view/item/context`:

```json
{
  "command": "forge.removeFromSolution",
  "when": "view == forge.solutionExplorer && viewItem == project",
  "group": "7_modification@3"
}
```

### 6.4 Solution Management Functions

Update `editors/vscode/src/solution.ts`:

- [ ] `addProjectToSolution(projectPath: string): Promise<Result<void, string>>`
  - Check if solution is loaded (get from state)
  - Run `dotnet sln <solution> add <project>`
  - Refresh Solution Explorer
- [ ] `removeProjectFromSolution(projectPath: string): Promise<Result<void, string>>`
  - Show confirmation dialog
  - Run `dotnet sln <solution> remove <project>`
  - Refresh Solution Explorer

### 6.5 Command Handlers

Register handlers in `editors/vscode/src/extension.ts`:

- [ ] `forge.addToSolution` — called from file explorer, gets URI from parameter
- [ ] `forge.removeFromSolution` — called from solution explorer, gets path from node

## Phase 7: Tests

- [ ] E2E test: Build action on solution runs `dotnet build` with correct path
- [ ] E2E test: Build action on project runs `dotnet build` with correct path
- [ ] E2E test: Run action executes `dotnet run` with configured args
- [ ] E2E test: Debug action starts debug session with correct configuration
- [ ] E2E test: Configure Build Args stores and retrieves per-project args
- [ ] E2E test: Configure Run Args stores and retrieves per-project args
- [ ] E2E test: Global extraArgs are applied when no per-project args set
- [ ] E2E test: Add to Solution from file explorer adds project correctly
- [ ] E2E test: Remove from Solution shows confirmation and removes project
- [ ] E2E test: Context menu visibility for Build/Rebuild on solution/project nodes
- [ ] E2E test: Context menu visibility for Run/Debug on project nodes only
- [ ] E2E test: Context menu visibility for Add to Solution on .csproj/.fsproj files

## Future Context Menu Items

- **Add Member** — scaffold a new method/property/field
- **Extract Interface** — generate an interface from a class's public members
- **Go to Implementation** — navigate to implementing types
- **Manage NuGet Packages** — add/update/remove packages (on Project/Package nodes)
- **Open Containing File** — open the source file in the editor (for non-symbol nodes)
- **Find All References** — find all references to the symbol across the workspace