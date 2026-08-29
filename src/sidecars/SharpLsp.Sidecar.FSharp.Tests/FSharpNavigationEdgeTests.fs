/// Navigation, formatting and rename behaviour at the edges a developer hits
/// daily but a happy-path suite never reaches: a member that overrides a base
/// AND satisfies an interface, an operator rather than an identifier, a name
/// that does not resolve at all, a file with Windows line endings, and a rename
/// to something that is not a legal F# identifier.
/// [SHARPLSP-FEATURES-NAVIGATION] / [RENAME-FSHARP-APPLY] / [DEFINITION-CROSSLANG].
module SharpLsp.Sidecar.FSharp.Tests.FSharpNavigationEdgeTests

open System
open System.IO
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpDeclarationKindTests

/// Caret two characters into `needle` on the fixture line that contains `anchor`.
let private caretAt (anchor: string) (needle: string) =
    let line = kindLineOf anchor
    let text = KIND_SOURCE.Split('\n')[line]
    (line, text.IndexOf(needle, StringComparison.Ordinal) + 2)

// ── Declaration versus definition on an overridden member ─────────

/// `Widget.Describe` overrides `Recorder.Describe` AND satisfies
/// `IDescribable.Describe`. On a call through a `Widget` value the two commands
/// must part company: go-to-DEFINITION lands on the code that runs (the
/// override), while go-to-DECLARATION climbs to the contract the member
/// satisfies (the interface's abstract member). Collapsing them makes one of the
/// two a no-op exactly where a developer is tracing an override.
[<Fact>]
let ``declaration climbs to the interface member while definition lands on the override`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let appended = "let described = widget.Describe()"
        let text = KIND_SOURCE + appended + "\n"
        FSharpWorkspace.applyDidChange state paths[0] text
        let line = text.Split('\n') |> Array.findIndex (fun l -> l = appended)
        let character = appended.IndexOf("Describe", StringComparison.Ordinal) + 2

        let! declaration = FSharpWorkspace.getDeclaration state paths[0] line character
        let! definition = FSharpWorkspace.getDefinition state paths[0] line character

        match declaration, definition with
        | Some declared, Some defined ->
            Assert.Equal(kindLineOf "abstract member Describe: unit -> string", declared.Line)
            Assert.Equal(kindLineOf "override _.Describe()", defined.Line)
            Assert.NotEqual(declared.Line, defined.Line)
        | _ -> failwith $"expected both a declaration and a definition, got %A{declaration} / %A{definition}"
    finally
        cleanup dir
}

// ── Definition on things that are not plain identifiers ────────────

/// `|>` is a real symbol with a real definition in FSharp.Core, but it is not an
/// identifier island, so the quick lexical lookup cannot see it. Definition must
/// fall back to the narrowest symbol use covering the caret instead of giving up.
[<Fact>]
let ``definition on a pipeline operator resolves through the covering symbol use`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let (line, character) = caretAt "let piped =" "|>"
        let! location = FSharpWorkspace.getDefinition state paths[0] line (character - 1)

        Assert.True(location.IsSome, "the pipeline operator must resolve to a definition")
    finally
        cleanup dir
}

/// A name that resolves to nothing must return no location rather than throwing
/// or pointing somewhere arbitrary — this is the state of every buffer that is
/// mid-edit, so it happens on almost every keystroke.
[<Fact>]
let ``definition of an unresolved identifier returns no location`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let appended = "let broken = notARealSymbolAnywhere"
        let text = KIND_SOURCE + appended + "\n"
        FSharpWorkspace.applyDidChange state paths[0] text
        let line = text.Split('\n') |> Array.findIndex (fun l -> l = appended)
        let! location = FSharpWorkspace.getDefinition state paths[0] line (appended.IndexOf("notARealSymbol") + 2)

        Assert.True(location.IsNone, "an unresolvable name must not produce a location")
    finally
        cleanup dir
}

/// A BCL property is a member of a decompilable type, so definition must land on
/// the member's own declaration inside the decompiled buffer.
[<Fact>]
let ``definition of a BCL property lands on the member in decompiled source`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let (line, character) = caretAt "let stamp =" "UtcNow"
        let! location = FSharpWorkspace.getDefinition state paths[0] line character

        match location with
        | None -> failwith "no definition found for DateTime.UtcNow"
        | Some found ->
            Assert.NotEqual<string>(paths[0], found.FilePath)
            Assert.True(File.Exists(found.FilePath), $"decompiled source must exist: {found.FilePath}")
            Assert.Contains("UtcNow", File.ReadAllText(found.FilePath))
    finally
        cleanup dir
}

// ── Formatting ─────────────────────────────────────────────────────

/// Fantomas defaults to the host newline. Formatting a CRLF document on a
/// non-Windows host must NOT rewrite it to LF: that turns a one-line format into
/// a whole-file diff for every Windows colleague.
[<Fact>]
let ``formatting a CRLF document keeps CRLF line endings`` () = task {
    let crlf = "module Crlf.Doc\r\n\r\nlet   value =    1\r\n"
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Doc.fs", "module Crlf.Doc\n\nlet value = 1\n" ]

    try
        FSharpWorkspace.applyDidChange state paths[0] crlf
        let! edits = FSharpFeatures.formatDocument state paths[0]

        Assert.NotEmpty(edits)
        let formatted = edits[0].NewText
        Assert.Contains("\r\n", formatted)
        // Every newline must still be paired with a carriage return.
        Assert.Equal(
            formatted |> Seq.filter (fun c -> c = '\n') |> Seq.length,
            formatted.Split("\r\n").Length - 1)
    finally
        cleanup dir
}

// ── Signature help without a project ───────────────────────────────

/// Signature help is requested the instant a user types `(`, which can be before
/// the workspace has finished loading. An unloaded workspace must answer "no
/// signatures" rather than throwing into the IPC layer.
[<Fact>]
let ``signature help on an unloaded workspace returns nothing`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let fresh = FSharpWorkspace.create ()
        let (line, character) = caretAt "let widget = Widget()" "Widget()"
        let! help = FSharpSignature.signatureHelp fresh paths[0] line (character + 6)

        Assert.True(help.IsNone, "an unloaded workspace has no project to resolve overloads against")
    finally
        cleanup dir
}

// ── Rename refusals ────────────────────────────────────────────────

/// A rename to something that is not a legal F# identifier must be refused with
/// an error. Applying it would write text the compiler cannot parse across every
/// use site in the project.
[<Fact>]
let ``renaming to an illegal F# identifier is refused`` () = task {
    let! (state, dir, _fsproj, paths) = kindProject ()

    try
        let (line, character) = caretAt "let sample =" "sample"
        let! renamed = FSharpRename.renameResult state paths[0] line character "9not-an-identifier"

        match renamed with
        | Ok edits -> failwith $"an illegal identifier must be refused, got {List.length edits} edits"
        | Error message -> Assert.Contains("9not-an-identifier", message)
    finally
        cleanup dir
}

/// Renaming inside a loaded `.fsx` must work: a script's symbols live in a file
/// that is not a `.fs` compile item, and the project-membership test has to
/// recognise the script itself as project source or the rename finds nothing.
[<Fact>]
let ``renaming a binding inside a loaded script rewrites its uses`` () = task {
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-fsx-rename-{Guid.NewGuid():N}")
    Directory.CreateDirectory(dir) |> ignore

    try
        let script = Path.Combine(dir, "Rename.fsx")
        File.WriteAllText(script, "let squared value = value * value\nlet answer = squared 7\n")
        let state = FSharpWorkspace.create ()
        let! loaded = FSharpWorkspace.loadProject state script

        match loaded with
        | Error message -> failwith $"script failed to load: {message}"
        | Ok() ->
            let! renamed = FSharpRename.renameResult state script 0 6 "cubed"

            match renamed with
            | Error message -> failwith $"script rename failed: {message}"
            | Ok edits ->
                // Declaration plus the call site on the second line.
                Assert.Equal(2, List.length edits)
                Assert.All(edits, fun (edit: FSharpCodeActions.RawEdit) -> Assert.Equal("cubed", edit.NewText))
    finally
        cleanup dir
}
