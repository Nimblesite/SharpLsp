# Solution Explorer Context Menus — Implementation Plan

**Spec:** [SOLUTION-EXPLORER-SPEC.md](../specs/SOLUTION-EXPLORER-SPEC.md)
**Status:** In Progress
**Last Updated:** 2026-03-22

## Overview

Add context menus to Solution Explorer tree nodes. Includes **Sort Members**, **Copy Qualified Name**, **Copy Name**, **Reveal in File Explorer**, and **Collapse All Children**.

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

## Phase 5: Tests

- [x] E2E test: Sort Members on a class with mixed accessibility/category members
- [x] E2E test: Sort Members preserves attached comments and attributes
- [x] E2E test: Sort Members with custom hierarchy config
- [x] E2E test: Sort Members on an enum, interface, and record
- [x] E2E test: Sort Members inserts blank lines between groups
- [x] E2E test: Sort Members preserves `#region` / `#endregion` blocks
- [ ] E2E test: Context menu only appears on correct node types
- [ ] E2E test: Verify `contextValue` is set correctly for all node types
- [ ] E2E test: Copy Qualified Name produces correct output for nested types
- [ ] E2E test: Copy Name copies unqualified name
- [ ] E2E test: Reveal in File Explorer opens correct file

## Future Context Menu Items

- **Add Member** — scaffold a new method/property/field
- **Extract Interface** — generate an interface from a class's public members
- **Go to Implementation** — navigate to implementing types
- **Manage NuGet Packages** — add/update/remove packages (on Project/Package nodes)
- **Open Containing File** — open the source file in the editor (for non-symbol nodes)
- **Find All References** — find all references to the symbol across the workspace
