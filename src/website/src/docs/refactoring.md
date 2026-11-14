---
layout: layouts/docs.njk
title: Refactoring & Code Actions
description: "Use C# and F# quick fixes in SharpLsp. Add imports, generate missing code, convert F# pipelines and move C# types into separate files."
eleventyNavigation:
  key: Refactoring & Code Actions
  order: 7
---

<img src="/assets/screenshots/docs/refactoring.webp" alt="Quick fixes on an incomplete F# match" width="2400" height="1500">

# Refactoring and Code Actions

Open a solution or project, wait for it to load, then put the cursor on an error or declaration. Press **Cmd+.** on macOS or **Ctrl+.** on Windows and Linux to open Quick Fix. Other LSP editors expose these actions through their code action menu.

{% video "refactoring-lesson" %}

{% video "move-type" %}

## F# quick fixes

| Context | Action |
|---|---|
| Undefined name (`FS0039`) | Add a resolving `open`, qualify the use, or add an applicable `open type` |
| Unused binding (`FS1182`) | Prefix the name with `_` |
| Discarded result (`FS0020`) | Add `\|> ignore` |
| Incomplete match (`FS0025`) | Generate missing union cases or add a wildcard arm |
| Redundant pattern (`FS0026`) | Remove the pattern |
| Supported type mismatch (`FS0001`) | Insert a known conversion |
| Record expression | Generate missing fields |
| Interface implementation | Generate member stubs |
| Unused `open` or qualified name | Remove the import or simplify the name |

For example, put the cursor on the incomplete match below and choose **Generate 1 missing union case(s)**.

```fsharp
type Stage = Browsing | CheckedOut of decimal

let describe stage =
    match stage with
    | Browsing -> "still browsing"
```

SharpLsp adds `| CheckedOut _ -> failwith "todo"`. Replace the generated body with your implementation.

For supported single-line expressions, the menu also converts `g a (f x)` to `x |> f |> g a`, and back. Available actions depend on the compiler diagnostic and the code under the cursor. See [F# language support](/docs/fsharp/) for the current coverage.

## Choose an import

Import fixes state what they change before you apply them.

| Intent | F# | C# |
|---|---|---|
| Import a namespace | `open System.Text` | `using System.Text;` |
| Qualify one use | `System.Text.StringBuilder` | `System.Text.StringBuilder` |
| Import only a type | Use its qualified name | `using StringBuilder = System.Text.StringBuilder;` |
| Import static members and nested types | `open type System.Math` | `using static System.Math;` |

Try `let builder = StringBuilder()` in F# or `var builder = new StringBuilder();` in C#, with no `System.Text` import. Open Quick Fix on `StringBuilder` to see the applicable choices. F# `open type` requires F# 5 or later.

For supported unresolved types, the menu can also add a reference to another same-language project in the solution or a NuGet package. The title names the reference and import. Package candidates come from packages already used in the solution or SharpLsp's supported package list.

## Generate C# code

Write a call to a method that does not exist yet, then open Quick Fix on its name. **Generate method** creates a stub with parameters inferred from the call. Roslyn supplies C# fixes and refactorings for the current syntax and selection.

## Move a C# type

Open Quick Fix on the declaration's name.

| Action | Result |
|---|---|
| **Move type to Receipt.cs** | Creates a file beside the source, keeping the namespace, imports, documentation and attributes |
| **Move 'Inner' out of 'Outer' to Inner.cs** | Makes the nested type top-level and updates references across the solution |
| **Rename file to Receipt.cs** | Renames the file to match its type |

The ordinary move keeps a nested type nested through partial container declarations. The move-out action checks for name conflicts, existing destination files and dependencies on inaccessible container members or enclosing type parameters. Moving a private nested type out makes it `internal`.

## Apply an action

Picking an action computes its edits, which can affect several files. If the action expired or cannot apply, SharpLsp reports the reason. Reference actions apply the import first, then add the reference. If adding the reference fails, the error explains that Undo removes the import.

For symbol rename, press **F2**. For formatting, install [CSharpier](https://csharpier.com/) for C# or [Fantomas](https://fsprojects.github.io/fantomas/) for F#.

{% video "refactoring" %}
