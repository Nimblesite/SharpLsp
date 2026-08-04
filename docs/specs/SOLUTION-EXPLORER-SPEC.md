# Solution Explorer Specification `[SE-SOLUTION-EXPLORER]`

## Overview `[SE-OVERVIEW]`

The Solution Explorer is a VS Code tree view that displays the full code hierarchy of a .NET solution: solutions, projects, namespaces, types, and members. It accepts legacy `.sln` and XML `.slnx` solution files. It is powered by a custom LSP request (`sharplsp/workspaceSymbols`) backed by the sidecar `solution/read` model, tree-sitter parsing in the Rust host for C#, and the FCS sidecar's `documentSymbol` for F# ([SE-FSHARP-SYMBOLS]).

## Architecture `[SE-ARCHITECTURE]`

```
VS Code Tree View
  └── SolutionExplorerProvider (TypeScript)
        └── sharplsp/workspaceSymbols request
              └── Rust Host
                    ├── solution/read sidecar request
                    │     └── .sln/.slnx → projects, folders, solution items
                    ├── tree-sitter parsing (C#)
                    │     └── .csproj → .cs files
                    └── FCS sidecar documentSymbol (F#)
                          └── .fsproj → .fs files
```

### Language-Specific Symbol Extraction [SE-FSHARP-SYMBOLS]

Per-file symbols are sourced by language, never by a single parser:

| Language | Source | Rationale |
|----------|--------|-----------|
| C# (`.cs`) | tree-sitter parsing in the Rust host | The host owns the C# grammar. |
| F# (`.fs`) | FCS sidecar `textDocument/documentSymbol` | The host has no F# grammar; every `.fs` file and its symbols MUST appear under an `.fsproj` exactly as C# does under `.csproj`. |

The F# path reuses the sidecar `documentSymbol` request that powers the editor outline. It maps nested FCS modules, namespaces, types, DU cases, and members into the shared `FileSymbol`/`SymbolNode` tree using full ranges. `workspace_symbols::handle` receives the F# sidecar; when unavailable, `.fs` files contribute no symbols without failing the request.

### Live-Buffer Path Identity [SE-LIVE-BUFFER]

`sharplsp/workspaceSymbols` MUST parse the latest open VFS text, including unsaved successive edits; disk content is used only when no open document denotes the source file.

Editor URIs and project models can name one file differently: for example, Windows can supply `C:\Users\RUNNER~1\...` while the sidecar supplies `C:\Users\runneradmin\...`. On open, the VFS stores the resolved editor path as document state, then native-path lookup compares both the original URI path and its canonical path. Comparison ignores Windows verbatim prefixes and casing. The VS Code explorer tests cover unsaved and burst edits; VFS regression tests cover reverse-alias lookup. Implementations: `src/sharplsp/src/vfs.rs`, `src/sharplsp/src/workspace_symbols.rs`, and `src/editors/vscode/src/test/suite/solution-explorer.test.ts`.

### Request: `sharplsp/workspaceSymbols` `[SE-WORKSPACE-SYMBOLS-REQUEST]`

**Params:**
```json
{ "solution": "/path/to/Solution.slnx" }
```

**Response:**
```json
{
  "solutionFolders": [
    {
      "name": "src",
      "guid": "/src/",
      "parentGuid": null
    }
  ],
  "projects": [
    {
      "name": "ProjectName",
      "path": "/absolute/path/to/Project.csproj",
      "parentFolder": "src",
      "symbols": [
        {
          "file": "/absolute/path/to/File.cs",
          "symbols": [
            {
              "name": "MyNamespace",
              "kind": "Namespace",
              "detail": null,
              "access": null,
              "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 10, "character": 1 } },
              "children": [
                {
                  "name": "MyClass",
                  "kind": "Class",
                  "detail": "BaseClass",
                  "access": "public",
                  "range": { ... },
                  "children": [ ... ]
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

### Symbol Kinds `[SE-SYMBOL-KINDS]`

| Kind | Tree-sitter Node | Icon | Theme Color |
|------|-----------------|------|-------------|
| Namespace | `namespace_declaration`, `file_scoped_namespace_declaration` | `symbol-namespace` | `symbolIcon.namespaceForeground` |
| Class | `class_declaration`, `record_declaration` | `symbol-class` | `symbolIcon.classForeground` |
| Struct | `struct_declaration` | `symbol-struct` | `symbolIcon.structForeground` |
| Interface | `interface_declaration` | `symbol-interface` | `symbolIcon.interfaceForeground` |
| Enum | `enum_declaration` | `symbol-enum` | `symbolIcon.enumeratorForeground` |
| EnumMember | `enum_member_declaration` | `symbol-enum-member` | `symbolIcon.enumeratorMemberForeground` |
| Method | `method_declaration` | `symbol-method` | `symbolIcon.methodForeground` |
| Constructor | `constructor_declaration` | `symbol-constructor` | `symbolIcon.constructorForeground` |
| Property | `property_declaration` | `symbol-property` | `symbolIcon.propertyForeground` |
| Field | `field_declaration` | `symbol-field` | `symbolIcon.fieldForeground` |
| Event | `event_declaration` | `symbol-event` | `symbolIcon.eventForeground` |
| Function | `delegate_declaration` | `symbol-method` | `symbolIcon.functionForeground` |
| Constant | — | `symbol-constant` | `symbolIcon.constantForeground` |

### Special Node Icons `[SE-SYMBOL-ICONS]`

| Node | Icon | Color |
|------|------|-------|
| Solution (.sln/.slnx) | `package` | `terminal.ansiGreen` |
| Project (.csproj/.fsproj) | `project` | `terminal.ansiCyan` |

### Access Modifier Extraction `[SE-SYMBOL-ACCESS]`

The `access` field is extracted from tree-sitter `modifier` child nodes. Recognized values:

- `public`
- `private`
- `protected`
- `internal`
- `protected internal` (two modifiers joined)
- `private protected` (two modifiers joined)

When no access modifier is present, `access` is `null`.

## Tree Hierarchy `[SE-TREE]`

```
Solution (SharpLsp.Sidecars.sln)
  └── Project (SharpLsp.Sidecar.Common)
        ├── Namespace (SharpLsp.Sidecar.Common.Messages)
        │     ├── Class (Envelope)
        │     │     ├── Property (Id : uint?)
        │     │     └── Property (Method : string?)
        │     └── Class (SidecarHost)
        └── Namespace (SharpLsp.Sidecar.Common.Ipc)
              └── Class (MessageRouter)
                    ├── Method (Register)
                    └── Method (HandleAsync)
```

### File-Scoped Namespace Handling `[SE-TREE-FILE-NAMESPACE]`

`tree-sitter-c-sharp` 0.23 emits `file_scoped_namespace_declaration` without nesting subsequent type declarations as children. The Rust host detects this pattern and reparents root-level types into the single file-scoped namespace.

### Namespace Merging `[SE-TREE-NAMESPACE-MERGE]`

Symbols from multiple files sharing the same namespace within a project are merged into a single namespace node.

## Sort Order `[SE-SORT]`

Three sort modes are available, cycled via a toolbar button:

| Mode | Behavior | Icon |
|------|----------|------|
| Natural (default) | Source file order — symbols appear as declared | `$(list-ordered)` |
| Alphabetical | A-Z by symbol name at every level | `$(case-sensitive)` |
| Accessibility | Grouped by access modifier, then alphabetical | `$(shield)` |

### Accessibility Sort Priority `[SE-SORT-ACCESS]`

| Priority | Access Level |
|----------|-------------|
| 0 | `public` |
| 1 | `protected internal` |
| 2 | `internal` |
| 3 | `protected` |
| 4 | `private protected` |
| 5 | `private` |
| 6 | No modifier (implicit) |

Within each access group, symbols are sorted alphabetically.

### Sort Scope `[SE-SORT-SCOPE]`

- Sorting applies recursively to namespace children, type children, and nested members
- Project order within a solution is preserved (follows `.sln` or `.slnx` declaration order)
- Sorting is client-side only — the current LSP response remains in shared reactive state and is re-sorted without a new request

### Context Key `[SE-SORT-CONTEXT]`

The current sort order is exposed via VS Code context key `sharplsp.sortOrder` (values: `natural`, `alphabetical`, `accessibility`). This controls which toolbar icon is visible.

## Commands `[SE-COMMANDS]`

| Command | Title | Icon | When |
|---------|-------|------|------|
| `sharplsp.selectSolution` | Select Solution | `$(folder-opened)` | Always |
| `sharplsp.refreshExplorer` | Refresh Explorer | `$(refresh)` | Always |
| `sharplsp.sortNatural` | Sort: Source Order | `$(list-ordered)` | `sharplsp.sortOrder == natural` |
| `sharplsp.sortAlphabetical` | Sort: Alphabetical | `$(case-sensitive)` | `sharplsp.sortOrder == alphabetical` |
| `sharplsp.sortAccessibility` | Sort: Accessibility | `$(shield)` | `sharplsp.sortOrder == accessibility` |

All three sort commands cycle to the next sort mode.

## Retry Logic `[SE-REQUEST-RETRY]`

The workspace symbols request retries up to three times with a two-second delay when the LSP client is unavailable or the connection fails transiently.

## Hover / Quick Info `[SE-HOVER]`

On symbol hover, the extension sends `textDocument/hover` at the declaration position and renders the response as a tree-item `MarkdownString`, reusing the editor pipeline specified by [HOVER-SPEC.md](HOVER-SPEC.md).

## Context Menus `[SE-CONTEXT-MENUS]`

`view/item/context` contributions are scoped by each node's `contextValue`.

### Sort Members `[SE-CONTEXT-SORT-MEMBERS]`

**Sort Members** reorders source members for Class, Struct, Interface, Enum, and Record nodes.

| Property | Value |
|----------|-------|
| Command | `sharplsp.sortMembers` |
| Title | Sort Members |
| When | `view == sharplsp.solutionExplorer && viewItem =~ /^symbol\.(class\|struct\|interface\|enum\|record)$/` |
| Group | `1_modification` |

#### Sort Hierarchy `[SE-CONTEXT-SORT-HIERARCHY]`

1. **Accessibility** — members are grouped by access modifier using [SE-SORT-ACCESS]
2. **Category** — within each accessibility group, members are grouped by kind:

| Priority | Category |
|----------|----------|
| 0 | Constants |
| 1 | Fields |
| 2 | Constructors |
| 3 | Finalizers (destructors) |
| 4 | Delegates |
| 5 | Events |
| 6 | Enums |
| 7 | Interfaces |
| 8 | Properties |
| 9 | Indexers |
| 10 | Operators |
| 11 | Methods |
| 12 | Structs |
| 13 | Classes |
| 14 | Records |

3. **Alphabetical** — within each category group, members are sorted A-Z by name

#### Settings `[SE-CONTEXT-SORT-SETTINGS]`

The sort hierarchy is configurable via the `sharplsp.memberSortOrder` setting:

```json
{
  "sharplsp.memberSortOrder": {
    "hierarchy": ["accessibility", "category", "alphabetical"],
    "accessibilityOrder": [
      "public",
      "protected internal",
      "internal",
      "protected",
      "private protected",
      "private"
    ],
    "categoryOrder": [
      "constant",
      "field",
      "constructor",
      "finalizer",
      "delegate",
      "event",
      "enum",
      "interface",
      "property",
      "indexer",
      "operator",
      "method",
      "struct",
      "class",
      "record"
    ]
  }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sharplsp.memberSortOrder.hierarchy` | `string[]` | `["accessibility", "category", "alphabetical"]` | Sort tiebreaker order. Valid values: `accessibility`, `category`, `alphabetical` |
| `sharplsp.memberSortOrder.accessibilityOrder` | `string[]` | See above | Access modifier priority (first = highest) |
| `sharplsp.memberSortOrder.categoryOrder` | `string[]` | See above | Member kind priority (first = highest) |

#### Implementation `[SE-CONTEXT-SORT-IMPLEMENTATION]`

Sort Members edits the source file:

1. User right-clicks a type node → selects "Sort Members"
2. Extension reads the type's `range` from the symbol data
3. Extension sends a `sharplsp/sortMembers` LSP request with the document URI and the type's range
4. Rust host uses tree-sitter to parse the type body, identify member declarations, and compute the sorted order
5. Rust host returns a `TextEdit[]` that reorders the members
6. Extension applies the edits via `workspace.applyEdit`

The tree view auto-refreshes after the edit (existing `onDidChangeTextDocument` listener).

### Copy Qualified Name `[SE-CONTEXT-COPY-QUALIFIED]`

**Copy Qualified Name** copies `Namespace.Type.Member` for any symbol node.

| Property | Value |
|----------|-------|
| Command | `sharplsp.copyQualifiedName` |
| Title | Copy Qualified Name |
| When | `view == sharplsp.solutionExplorer && viewItem =~ /^symbol\./ ` |
| Group | `9_cutcopypaste` |

The qualified name is built by walking the tree from the node to the root, collecting namespace and type names.

### Copy Name `[SE-CONTEXT-COPY-NAME]`

**Copy Name** copies the unqualified name of a symbol, project, or solution.

| Property | Value |
|----------|-------|
| Command | `sharplsp.copyName` |
| Title | Copy Name |
| When | `view == sharplsp.solutionExplorer && viewItem =~ /^(symbol\.\|solution\|project)/ ` |
| Group | `9_cutcopypaste` |

### Reveal in File Explorer `[SE-CONTEXT-REVEAL]`

**Reveal in File Explorer** reveals a symbol's source file in VS Code's file explorer.

| Property | Value |
|----------|-------|
| Command | `sharplsp.revealInExplorer` |
| Title | Reveal in File Explorer |
| When | `view == sharplsp.solutionExplorer && viewItem =~ /^symbol\./ ` |
| Group | `3_open` |

### Collapse All Children `[SE-CONTEXT-COLLAPSE]`

**Collapse All Children** collapses every descendant of a collapsible node.

| Property | Value |
|----------|-------|
| Command | `sharplsp.collapseChildren` |
| Title | Collapse All Children |
| When | `view == sharplsp.solutionExplorer` |
| Group | `inline` |

## Build, Run, and Debug Actions `[SE-ACTIONS]`

### Build and Rebuild `[SE-ACTIONS-BUILD]`

Solution and project nodes expose **Build** and **Rebuild**.

| Property | Value |
|----------|-------|
| Command | `sharplsp.build` |
| Title | Build |
| When | `view == sharplsp.solutionExplorer && viewItem =~ /^(solution\|project)$/` |
| Group | `2_build@1` |

| Property | Value |
|----------|-------|
| Command | `sharplsp.rebuild` |
| Title | Rebuild |
| When | `view == sharplsp.solutionExplorer && viewItem =~ /^(solution\|project)$/` |
| Group | `2_build@2` |

**Build Behavior:**
- On solution: runs `dotnet build <solution.sln|solution.slnx>` with configured extra args
- On project: runs `dotnet build <project.csproj>` with configured extra args
- Output appears in VS Code terminal
- Progress notification shown during build

### Run and Debug `[SE-ACTIONS-RUN-DEBUG]`

Project nodes expose **Run** and **Debug**.

| Property | Value |
|----------|-------|
| Command | `sharplsp.run` |
| Title | Run |
| When | `view == sharplsp.solutionExplorer && viewItem == project` |
| Group | `3_run@1` |

| Property | Value |
|----------|-------|
| Command | `sharplsp.debug` |
| Title | Debug |
| When | `view == sharplsp.solutionExplorer && viewItem == project` |
| Group | `3_run@2` |

**Run Behavior:**
- Runs `dotnet run --project <project.csproj>` with configured extra args
- Output appears in VS Code terminal

**Debug Behavior:**
- Starts a debug session using VS Code's debug API
- Uses the `sharplsp` debug configuration type
- Attaches debugger to the running process

### Configure Extra Arguments `[SE-ACTIONS-ARGS]`

| Property | Value |
|----------|-------|
| Command | `sharplsp.configureBuildArgs` |
| Title | Configure Build Arguments... |
| When | `view == sharplsp.solutionExplorer && viewItem =~ /^(solution\|project)$/` |
| Group | `9_configure@1` |

| Property | Value |
|----------|-------|
| Command | `sharplsp.configureRunArgs` |
| Title | Configure Run Arguments... |
| When | `view == sharplsp.solutionExplorer && viewItem == project` |
| Group | `9_configure@2` |

**Configuration Storage:**
- Per-project args stored in workspace state: `sharplsp.buildArgs.${projectPath}` and `sharplsp.runArgs.${projectPath}`
- Global defaults configured via settings:
  - `sharplsp.build.extraArgs` — default args for all build operations
  - `sharplsp.run.extraArgs` — default args for all run operations
  - `sharplsp.test.extraArgs` — default args for test operations

**Argument Precedence:**
1. Per-project configured args (highest priority)
2. Global setting `sharplsp.*.extraArgs`
3. No extra args (lowest priority)

## Solution Management `[SE-SOLUTION]`

### Add Project to Solution `[SE-SOLUTION-ADD]`

When a solution is loaded, `.csproj` and `.fsproj` files expose **Add to Solution**.

| Property | Value |
|----------|-------|
| Command | `sharplsp.addToSolution` |
| Title | Add to Solution |
| When | `resourceExtname == .csproj \|\| resourceExtname == .fsproj` |
| Group | `2_solution@1` |

**Behavior:**
- Runs `dotnet sln <current-solution> add <project-path>`
- Refreshes Solution Explorer after adding
- Shows error if no solution is loaded

### Remove Project from Solution `[SE-SOLUTION-REMOVE]`

Project nodes expose **Remove from Solution**.

| Property | Value |
|----------|-------|
| Command | `sharplsp.removeFromSolution` |
| Title | Remove from Solution |
| When | `view == sharplsp.solutionExplorer && viewItem == project` |
| Group | `7_modification@3` |

**Behavior:**
- Shows confirmation dialog before removing
- Runs `dotnet sln <solution> remove <project-path>`
- Refreshes Solution Explorer after removing

### Context Value Mapping `[SE-CONTEXT-VALUES]`

Nodes set `contextValue` by kind:

| Symbol Kind | contextValue |
|-------------|-------------|
| Class | `symbol.class` |
| Struct | `symbol.struct` |
| Interface | `symbol.interface` |
| Enum | `symbol.enum` |
| Record | `symbol.record` |
| Method | `symbol.method` |
| Property | `symbol.property` |
| Field | `symbol.field` |
| Event | `symbol.event` |
| Constructor | `symbol.constructor` |
| Constant | `symbol.constant` |
| EnumMember | `symbol.enumMember` |
| Namespace | `symbol.namespace` |
| Delegate | `symbol.delegate` |
| Solution | `solution` |
| Project | `project` |
| NuGet Package | `nugetPackage` |
| Project Reference | `projectReference` |
| Dependency Folder | `dependencyFolder` |

## Navigation `[SE-NAVIGATION]`

Clicking a symbol node opens the file and navigates to the symbol's declaration position.

## Active Editor Synchronization `[SE-ACTIVE-EDITOR-SYNC]`

When a C# or F# document becomes active through open, focus, navigation, Quick Open, or tab switch, the tree MUST expand its ancestors, reveal its node, and select it without stealing focus. This editor-to-tree behavior is the inverse of [SE-CONTEXT-REVEAL].

### Requirements `[SE-ACTIVE-EDITOR-SYNC-REQUIREMENTS]`

| # | Requirement |
|---|-------------|
| 1 | A reference to the `TreeView` returned by `createTreeView` MUST be retained so `TreeView.reveal()` can be called. |
| 2 | `SolutionExplorerProvider` MUST implement `getParent()` (VS Code requires it for `reveal()`). |
| 3 | A `window.onDidChangeActiveTextEditor` listener MUST locate the node whose file URI (`symbolUri`) matches the active document and call `treeView.reveal(node, { select: true, focus: false, expand: true })`. |
| 4 | Sync MUST re-run after the tree is (re)populated (`onDidChangeTreeData`) so a newly loaded tree still reveals the current editor — per [VSCODE-REACTIVITY-SPEC](VSCODE-REACTIVITY-SPEC.md). |
| 5 | A setting (mirroring `explorer.autoReveal`, default **on**) MUST gate the behaviour so users can disable it. |
| 6 | Revealing MUST NOT steal editor focus (`focus: false`) and MUST be a no-op when the active document has no corresponding node (e.g. files outside the loaded solution). |

## Key Files `[SE-FILES]`

| File | Purpose |
|------|---------|
| [tree.ts](../../src/editors/vscode/src/tree.ts) | Tree data provider, node construction, sorting |
| [extension.ts](../../src/editors/vscode/src/extension.ts) | Command registration, tree view creation |
| [constants.ts](../../src/editors/vscode/src/constants.ts) | Command and view ID constants |
| [package.json](../../src/editors/vscode/package.json) | VS Code contribution points |
| [workspace_symbols.rs](../../src/sharplsp/src/workspace_symbols.rs) | Rust handler: sidecar solution model routing, tree-sitter symbol extraction |
| [solution-explorer.test.ts](../../src/editors/vscode/src/test/suite/solution-explorer.test.ts) | Coarse tree, command, reactivity, and live-buffer coverage |
