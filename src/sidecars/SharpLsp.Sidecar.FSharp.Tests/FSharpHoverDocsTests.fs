/// F# hover on .NET framework symbols carries their XML documentation from the
/// `.xml` files beside the reference assemblies, as C# hover does, while the
/// project's own `///` docs keep rendering. Real `.fsproj`, real reference pack,
/// real FSharpChecker. Implements [HOVER-FSHARP-RENDERING] (GitHub #388).
module SharpLsp.Sidecar.FSharp.Tests.FSharpHoverDocsTests

open System.IO
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.SidecarEndToEndTests

/// Framework types, a framework constructor and method, an FSharp.Core function, and a
/// documented binding of the project.
let private appended =
    "\n/// Doubles a value for the hover test.\n"
    + "let doubled (value: int) = value * 2\n"
    + "let sessions: System.Collections.Generic.Dictionary<int, string> =\n"
    + "    System.Collections.Generic.Dictionary<int, string>()\n"
    + "let trimmed = \" padded \".Trim()\n"
    + "let squares = List.map (fun n -> n * n) [ 1; 2 ]\n"

/// The hover markdown at the `occurrence`-th (0-based) `word` of `source`, a few characters in.
let private hoverAt ws file (source: string) (word: string) occurrence =
    task {
        let lines = source.Replace("\r\n", "\n").Split('\n')
        let line, column =
            lines
            |> Seq.indexed
            |> Seq.collect (fun (index, text) ->
                Seq.unfold
                    (fun (start: int) ->
                        match text.IndexOf(word, start, System.StringComparison.Ordinal) with
                        | -1 -> None
                        | found -> Some((index, found), found + word.Length))
                    0)
            |> Seq.item occurrence
        let! hover = FSharpWorkspace.getHover ws file line (column + 2)
        Assert.True(hover.IsSome, $"no hover on {word} #{occurrence}")
        let markdown, _, _, _, _ = hover.Value
        return markdown
    }

[<Fact>]
let ``hover on framework and FSharp.Core symbols shows their XML docs, beside the project's own`` () =
    task {
        let dir = createTestProject ()
        try
            let ws = FSharpWorkspace.create ()
            let! _ = FSharpWorkspaceLoading.loadProject ws dir
            let src = NativePaths.Resolve(dir, "Library.fs")
            let edited = File.ReadAllText(src) + appended
            FSharpWorkspace.applyDidChange ws src edited

            let! typeHover = hoverAt ws src edited "Dictionary" 0
            Assert.Contains("```fsharp", typeHover)
            Assert.Contains("Represents a collection of keys and values.", typeHover)
            Assert.DoesNotContain("<summary>", typeHover)

            let! constructorHover = hoverAt ws src edited "Dictionary" 1
            Assert.Contains("Initializes a new instance of the", constructorHover)
            Assert.Contains("class that is empty", constructorHover)

            let! methodHover = hoverAt ws src edited "Trim" 0
            Assert.Contains("Trim", methodHover)
            Assert.Contains("Removes all leading and trailing white-space characters", methodHover)

            let! coreHover = hoverAt ws src edited ".map (fun" 0
            Assert.Contains("Builds a new collection whose elements are the results of applying the given function", coreHover)

            let! ownHover = hoverAt ws src edited "doubled" 0
            Assert.Contains("Doubles a value for the hover test.", ownHover)
            Assert.DoesNotContain("Represents a collection", ownHover)
        finally
            try Directory.Delete(dir, true) with _ -> ()
    }
