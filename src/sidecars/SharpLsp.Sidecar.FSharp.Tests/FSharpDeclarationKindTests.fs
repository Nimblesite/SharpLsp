/// Symbol and completion KINDS over a real F# project.
///
/// The kind string is not cosmetic: the Rust host maps it straight onto the LSP
/// `SymbolKind` / `CompletionItemKind` the editor renders, so a wrong mapping
/// shows a record field as a class, or a property as a keyword, in every editor
/// at once. These tests pin the mapping for the declarations F# developers
/// actually write. [SE-FSHARP-SYMBOLS] / [SHARPLSP-FEATURES-INTELLIGENCE].
module SharpLsp.Sidecar.FSharp.Tests.FSharpDeclarationKindTests

open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

/// A real project whose declarations span the kinds the mapper distinguishes:
/// an explicit CLR interface, a delegate, a literal constant, a mutable value,
/// a record, an abstract base and a derived type that both overrides the base
/// member and implements the interface.
let internal KIND_SOURCE =
    source
        [ "module KindProject.Kinds"
          ""
          "open System"
          ""
          "type IDescribable ="
          "    interface"
          "        abstract member Describe: unit -> string"
          "    end"
          ""
          "type Transform = delegate of int -> int"
          ""
          "[<Literal>]"
          "let MaxCount = 42"
          ""
          "let mutable tally = 0"
          ""
          "type Reading = { Sensor: string; Celsius: float }"
          ""
          "type Recorder() ="
          "    abstract member Describe: unit -> string"
          "    default _.Describe() = \"recorder\""
          ""
          "type Widget() ="
          "    inherit Recorder()"
          "    interface IDescribable with"
          "        member _.Describe() = \"widget\""
          "    override _.Describe() = \"widget-override\""
          "    member val Label = \"w\" with get, set"
          ""
          "let sample = { Sensor = \"s1\"; Celsius = 21.5 }"
          "let widget = Widget()"
          "let doubler = Transform(fun value -> value * 2)"
          "let piped = [ 1; 2; 3 ] |> List.sum"
          "let stamp = DateTime.UtcNow" ]

let internal kindProject () = loadWorkspace [ "Kinds.fs", KIND_SOURCE ]

/// 0-based index of the fixture line containing `needle`.
let internal kindLineOf (needle: string) =
    KIND_SOURCE.Split('\n') |> Array.findIndex (fun line -> line.Contains(needle))

/// Every (name, kind) pair in a symbol tree, top level and nested.
let private allKinds (items: FSharpSymbols.SymbolItem list) =
    let rec walk acc (xs: FSharpSymbols.SymbolItem list) =
        xs
        |> List.fold
            (fun state (item: FSharpSymbols.SymbolItem) -> walk ((item.Name, item.Kind) :: state) item.Children)
            acc

    walk [] items

/// Complete against an in-memory buffer: the fixture text plus one appended
/// line, with the caret at its end — exactly where a developer would be typing.
let internal completeAppended (state: FSharpWorkspace.FSharpWorkspaceState) source (appended: string) =
    task {
        let text = KIND_SOURCE + appended + "\n"
        FSharpWorkspace.applyDidChange state source text
        let line = text.Split('\n') |> Array.findIndex (fun l -> l = appended)
        let! items = FSharpCompletion.getCompletions state source line appended.Length
        return items
    }

let private kindOf (items: FSharpCompletion.CompletionEntry list) (label: string) =
    items
    |> List.tryFind (fun item -> item.Label = label)
    |> Option.map (fun item -> item.Kind)

// ── Document symbols ─────────────────────────────────────────────

/// The outline must not collapse every declaration into one icon: a module, a
/// type, a function and a value each map to their own kind, and the mapping is
/// what the editor's outline, breadcrumb and symbol search all render.
[<Fact>]
let ``document symbols map modules, types, members and values to distinct kinds`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let! symbols = FSharpSymbols.documentSymbols state paths[0]
        let kinds = allKinds symbols |> Map.ofList

        Assert.Equal("Module", kinds["KindProject.Kinds"])
        Assert.Equal("Class", kinds["Reading"])
        Assert.Equal("Function", kinds["Describe"])
        Assert.Equal("Field", kinds["sample"])
    finally
        cleanup dir
}

// ── Completion ───────────────────────────────────────────────────

/// Record fields must complete as fields, not as methods: `sample.Sensor` is
/// data, and the editor icons and sorts it by that kind.
[<Fact>]
let ``completion on a record value reports its fields as Field`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let! items = completeAppended state paths[0] "let probe = sample."
        Assert.NotEmpty(items)
        Assert.Equal(Some "Field", kindOf items "Sensor")
        Assert.Equal(Some "Field", kindOf items "Celsius")
    finally
        cleanup dir
}

/// An auto-property (`member val`) must complete as a property and a method as a
/// method — the two most common members on any .NET object must not collapse
/// into one icon.
[<Fact>]
let ``completion on a class instance separates properties from methods`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let! items = completeAppended state paths[0] "let probe = widget."
        Assert.NotEmpty(items)
        Assert.Equal(Some "Property", kindOf items "Label")
        Assert.Equal(Some "Method", kindOf items "Describe")
    finally
        cleanup dir
}

/// Completing a BCL type surfaces a member F# itself has no declaration syntax
/// for: a CLR event, which has its own completion kind.
[<Fact>]
let ``completion on a BCL type reports its event members as Event`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let! items = completeAppended state paths[0] "let probe = Console."
        Assert.NotEmpty(items)
        Assert.Equal(Some "Event", kindOf items "CancelKeyPress")
    finally
        cleanup dir
}

/// A `[<Literal>]` must complete as a constant rather than as a plain value:
/// it is the only kind of binding legal in a `match` pattern, and the icon is
/// the only hint a developer gets before the compiler rejects the pattern.
[<Fact>]
let ``completion of a module literal reports Constant`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let! items = completeAppended state paths[0] "let probe = Max"
        Assert.NotEmpty(items)
        Assert.Equal(Some "Constant", kindOf items "MaxCount")
        // A union case is not a constant, even though both are compile-time values.
        Assert.Equal(Some "EnumMember", kindOf items "Some")
    finally
        cleanup dir
}
