# Solution Explorer Specification

**Status:** Active
**Owner:** Forge LSP
**Last Updated:** 2026-03-21

## Overview

The Solution Explorer is a VS Code tree view that displays the full code hierarchy of a .NET solution: solutions, projects, namespaces, types, and members. It is powered by a custom LSP request (`forge/workspaceSymbols`) backed by tree-sitter parsing in the Rust host.

See [LSP-ARCHITECTURE-SPEC.md](specs/LSP-ARCHITECTURE-SPEC.md) for shared LSP architecture.

## Architecture

```
VS Code Tree View
  └── SolutionExplorerProvider (TypeScript)
        └── forge/workspaceSymbols request
              └── Rust Host (tree-sitter parsing)
                    └── .sln → .csproj/.fsproj → .cs/.fs files
```

### Request: `forge/workspaceSymbols`

**Params:**
```json
{ "solution": "/path/to/Solution.sln" }
```

**Response:**
```json
{
  "projects": [
    {
      "name": "ProjectName",
      "path": "/absolute/path/to/Project.csproj",
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

### Symbol Kinds

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

### Special Node Icons

| Node | Icon | Color |
|------|------|-------|
| Solution (.sln) | `package` | `terminal.ansiGreen` |
| Project (.csproj/.fsproj) | `project` | `terminal.ansiCyan` |

### Access Modifier Extraction

The `access` field is extracted from tree-sitter `modifier` child nodes. Recognized values:

- `public`
- `private`
- `protected`
- `internal`
- `protected internal` (two modifiers joined)
- `private protected` (two modifiers joined)

When no access modifier is present, `access` is `null`.

## Tree Hierarchy

```
Solution (Forge.Sidecars.sln)
  └── Project (Forge.Sidecar.Common)
        ├── Namespace (Forge.Sidecar.Common.Messages)
        │     ├── Class (Envelope)
        │     │     ├── Property (Id : uint?)
        │     │     └── Property (Method : string?)
        │     └── Class (SidecarHost)
        └── Namespace (Forge.Sidecar.Common.Ipc)
              └── Class (MessageRouter)
                    ├── Method (Register)
                    └── Method (HandleAsync)
```

### File-Scoped Namespace Handling

`tree-sitter-c-sharp` 0.23 emits `file_scoped_namespace_declaration` without nesting subsequent type declarations as children. The Rust host detects this pattern and reparents root-level types into the single file-scoped namespace.

### Namespace Merging

Symbols from multiple files sharing the same namespace within a project are merged into a single namespace node.

## Sort Order

Three sort modes are available, cycled via a toolbar button:

| Mode | Behavior | Icon |
|------|----------|------|
| Natural (default) | Source file order — symbols appear as declared | `$(list-ordered)` |
| Alphabetical | A-Z by symbol name at every level | `$(case-sensitive)` |
| Accessibility | Grouped by access modifier, then alphabetical | `$(shield)` |

### Accessibility Sort Priority

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

### Sort Scope

- Sorting applies recursively to namespace children, type children, and nested members
- Project order within a solution is preserved (follows .sln declaration order)
- Sorting is client-side only — the LSP response is cached and re-sorted without a new request

### Context Key

The current sort order is exposed via VS Code context key `forge.sortOrder` (values: `natural`, `alphabetical`, `accessibility`). This controls which toolbar icon is visible.

## Commands

| Command | Title | Icon | When |
|---------|-------|------|------|
| `forge.selectSolution` | Select Solution | `$(folder-opened)` | Always |
| `forge.refreshExplorer` | Refresh Explorer | `$(refresh)` | Always |
| `forge.sortNatural` | Sort: Source Order | `$(list-ordered)` | `forge.sortOrder == natural` |
| `forge.sortAlphabetical` | Sort: Alphabetical | `$(case-sensitive)` | `forge.sortOrder == alphabetical` |
| `forge.sortAccessibility` | Sort: Accessibility | `$(shield)` | `forge.sortOrder == accessibility` |

All three sort commands cycle to the next sort mode.

## Retry Logic

The workspace symbols request retries up to 3 times with a 2-second delay when:
- The LSP client is not yet running
- A transient error occurs (disposed connection, etc.)

## Hover / Quick Info

Symbol nodes in the Solution Explorer support hover tooltips showing the same rich Markdown documentation as the editor hover. This reuses the shared hover pipeline — the same sidecar hover handler and Markdown rendering code powers both surfaces.

See [HOVER-SPEC.md](HOVER-SPEC.md) for the full hover specification, including symbol resolution, XML doc rendering, and caching strategy.

When the user hovers over a symbol node in the tree view, the extension sends a `textDocument/hover` request for that symbol's declaration position. The response is displayed as a VS Code tree item tooltip using `MarkdownString`.

## Context Menus

Symbol nodes in the Solution Explorer expose context menu actions via `view/item/context` contribution points. Context menus are scoped by `contextValue` so that only relevant actions appear for each node type.

### Sort Members

Right-clicking a type node (Class, Struct, Interface, Enum, Record) shows a **Sort Members** action that reorders the members of that type in the source file.

| Property | Value |
|----------|-------|
| Command | `forge.sortMembers` |
| Title | Sort Members |
| When | `view == forge.solutionExplorer && viewItem =~ /^symbol\.(class\|struct\|interface\|enum\|record)$/` |
| Group | `1_modification` |

#### Sort Hierarchy

The default sort hierarchy is **Accessibility → Category → Alphabetical**:

1. **Accessibility** — members are grouped by access modifier using the same priority table as [Accessibility Sort Priority](#accessibility-sort-priority)
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

#### Settings

The sort hierarchy is configurable via the `forge.memberSortOrder` setting:

```json
{
  "forge.memberSortOrder": {
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
| `forge.memberSortOrder.hierarchy` | `string[]` | `["accessibility", "category", "alphabetical"]` | Sort tiebreaker order. Valid values: `accessibility`, `category`, `alphabetical` |
| `forge.memberSortOrder.accessibilityOrder` | `string[]` | See above | Access modifier priority (first = highest) |
| `forge.memberSortOrder.categoryOrder` | `string[]` | See above | Member kind priority (first = highest) |

#### Implementation

Sort Members is a **source-editing action** — it modifies the source file, not just the tree view. The flow:

1. User right-clicks a type node → selects "Sort Members"
2. Extension reads the type's `range` from the symbol data
3. Extension sends a `forge/sortMembers` LSP request with the document URI and the type's range
4. Rust host uses tree-sitter to parse the type body, identify member declarations, and compute the sorted order
5. Rust host returns a `TextEdit[]` that reorders the members
6. Extension applies the edits via `workspace.applyEdit`

The tree view auto-refreshes after the edit (existing `onDidChangeTextDocument` listener).

### Copy Qualified Name

Right-clicking any symbol node shows a **Copy Qualified Name** action that copies the fully-qualified name (`Namespace.Type.Member`) to the clipboard.

| Property | Value |
|----------|-------|
| Command | `forge.copyQualifiedName` |
| Title | Copy Qualified Name |
| When | `view == forge.solutionExplorer && viewItem =~ /^symbol\./ ` |
| Group | `9_cutcopypaste` |

The qualified name is built by walking the tree from the node to the root, collecting namespace and type names.

### Copy Name

Right-clicking any symbol, project, or solution node shows a **Copy Name** action that copies the unqualified name to the clipboard.

| Property | Value |
|----------|-------|
| Command | `forge.copyName` |
| Title | Copy Name |
| When | `view == forge.solutionExplorer && viewItem =~ /^(symbol\.\|solution\|project)/ ` |
| Group | `9_cutcopypaste` |

### Reveal in File Explorer

Right-clicking a symbol node shows a **Reveal in File Explorer** action that reveals the file containing the symbol in the VS Code file explorer.

| Property | Value |
|----------|-------|
| Command | `forge.revealInExplorer` |
| Title | Reveal in File Explorer |
| When | `view == forge.solutionExplorer && viewItem =~ /^symbol\./ ` |
| Group | `3_open` |

### Collapse All Children

Right-clicking any collapsible node shows a **Collapse All Children** action that collapses all descendant nodes.

| Property | Value |
|----------|-------|
| Command | `forge.collapseChildren` |
| Title | Collapse All Children |
| When | `view == forge.solutionExplorer` |
| Group | `inline` |

### Context Value Mapping

To support scoped context menus, symbol nodes set `contextValue` based on their kind:

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

## Navigation

Clicking a symbol node opens the file and navigates to the symbol's declaration position.

## Key Files

| File | Purpose |
|------|---------|
| `editors/vscode/src/tree.ts` | Tree data provider, node construction, sorting |
| `editors/vscode/src/extension.ts` | Command registration, tree view creation |
| `editors/vscode/src/constants.ts` | Command and view ID constants |
| `editors/vscode/package.json` | VS Code contribution points |
| `src/workspace_symbols.rs` | Rust handler: .sln parsing, tree-sitter symbol extraction |
