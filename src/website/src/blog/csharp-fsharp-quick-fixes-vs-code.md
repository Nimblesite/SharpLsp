---
layout: layouts/blog.njk
title: "C# and F# Quick Fixes in Visual Studio Code"
description: "SharpLsp adds explicit import choices for C# and F#, plus C# type-to-file refactoring. Fix missing namespaces from the VS Code lightbulb."
date: 2026-11-10
author: SharpLsp Team
image: /assets/images/blog/csharp-fsharp-quick-fixes-vs-code.webp
imageAlt: "Ivory F# and C# tiles joined by an emerald connector"
tags:
  - posts
  - csharp
  - fsharp
  - dotnet-lsp
category: announcement
excerpt: "Choose a namespace import, qualify one use, or import static members. SharpLsp's quick fixes now spell out the edit before you apply it."
---

An unresolved name can need a namespace, a qualified name or a missing project reference. SharpLsp's C# and F# quick fixes now tell you which change they will make. These improvements ship in version 0.32 and remain available in 0.33.

In Visual Studio Code, put the cursor on the error and press **Ctrl+.** (**Cmd+.** on macOS).

## F# imports

For an unresolved `StringBuilder`, choose `open System.Text` or qualify that use as `System.Text.StringBuilder`. For a static member such as `Sqrt`, the menu can offer `open type System.Math`.

Completion also offers types from unopened namespaces and inserts their `open` when accepted. The quick-fix titles explain what each import brings into scope. Where a supported project or package reference is missing, a separate action names the reference it will add.

## C# imports

For the same `StringBuilder` error, choose among three edits.

- Add `using System.Text;`.
- Import just the type with `using StringBuilder = System.Text.StringBuilder;`.
- Qualify the use as `System.Text.StringBuilder`.

Static members can also get a `using static` fix. If an action cannot apply, SharpLsp reports the reason.

## Move a C# type into its own file

Put the cursor on a type name and choose **Move type to Receipt.cs** to give `Receipt` its own file. Its namespace, imports, documentation and attributes travel with it.

A nested type has a separate **Move 'Inner' out of 'Outer' to Inner.cs** action. That makes it a top-level type and updates references across the solution. The action checks for conflicts and inaccessible container members before offering the move.

Install SharpLsp from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp). The [refactoring guide](/docs/refactoring/) covers the shortcuts and supported actions.
