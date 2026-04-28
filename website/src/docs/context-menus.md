---
layout: layouts/docs.njk
title: Context Menus
eleventyNavigation:
  key: Context Menus
  order: 9
---

![Solution Explorer context menu](/assets/screenshots/vscode-solution-explorer-context-menu.png)

*Right-click any node in the Solution Explorer for context-aware actions.*

# Context Menus

Forge adds rich context menus throughout VS Code — in the Solution Explorer tree, the editor, and the Problems panel. Every action is scoped precisely to the node type it applies to.

## Solution Explorer Context Menu

![Open project file from context menu](/assets/screenshots/vscode-context-menu-open-project.png)

Right-clicking a node in the Solution Explorer shows actions appropriate to that node:

| Node type | Available actions |
|-----------|------------------|
| Solution | Copy Name |
| Project | Open Project File, Build, Rebuild, Clean, Browse NuGet Packages, Add Project Reference, Copy Name |
| Namespace | Copy Qualified Name, Copy Name, Reveal in Explorer |
| Class / Struct / Interface / Enum / Record | Sort Members, Copy Qualified Name, Copy Name, Reveal in Explorer |
| Method / Property / Field / Event | Copy Qualified Name, Copy Name, Reveal in Explorer |

### Copy Qualified Name

Copies the fully-qualified name of the selected symbol to the clipboard — e.g. `MyNamespace.MyClass.MyMethod`. Useful for logging, documentation, and test assertions.

### Copy Name

Copies the unqualified name — e.g. `MyMethod`. Available on all node types including solution and project nodes.

### Reveal in Explorer

Opens the VS Code file explorer at the source file that defines the selected symbol.

### Sort Members

Sorts the members of a class, struct, interface, enum, or record alphabetically. Available on type-level nodes only.

### Build / Rebuild / Clean

Runs `dotnet build`, `dotnet build --no-incremental`, or `dotnet clean` on the selected project.

### Open Project File

Opens the `.csproj` or `.fsproj` file in the editor.

### Browse NuGet Packages

Opens the [NuGet Package Manager](./nuget.md) panel scoped to the selected project.

### Add Project Reference

Opens a file picker to select another project to reference.
