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

/// A dotnet root with the reference packs `packs`, each `(version, summary)`
/// documenting `M:System.String.Trim`, and the runtime implementation assembly
/// of `runtime`, which ships no documentation of its own.
let private dotnetRoot (packs: (string * string) list) (runtime: string) =
    let root = Directory.CreateTempSubdirectory("sharplsp-dotnet-").FullName

    for version, summary in packs do
        let refs = Directory.CreateDirectory(NativePaths.Resolve(root, "packs", "Microsoft.NETCore.App.Ref", version, "ref", "net10.0"))
        let xml = $"<doc><members><member name=\"M:System.String.Trim\"><summary>{summary}</summary></member></members></doc>"
        File.WriteAllText(NativePaths.Resolve(refs.FullName, "System.Runtime.xml"), xml)

    let shared = Directory.CreateDirectory(NativePaths.Resolve(root, "shared", "Microsoft.NETCore.App", runtime))
    let assembly = NativePaths.Resolve(shared.FullName, "System.Private.CoreLib.dll")
    File.WriteAllBytes(assembly, [||])
    root, assembly

/// The documentation `tryMember` finds for `M:System.String.Trim` on `runtime`.
let private trimDocsOn packs runtime =
    let root, assembly = dotnetRoot packs runtime

    try
        Hover.FSharpXmlDocFiles.tryMember assembly "M:System.String.Trim"
    finally
        try Directory.Delete(root, true) with _ -> ()

[<Fact>]
let ``a runtime with no reference pack of its own version is documented by the newest pack of its major version`` () =
    let packs = [ "9.0.20", "nine"; "10.0.0", "ten zero"; "10.0.2", "ten two"; "10.0.11", "ten eleven"; "11.0.0", "eleven" ]

    Assert.Contains("ten zero", trimDocsOn packs "10.0.0" |> Option.defaultValue "")
    Assert.Contains("nine", trimDocsOn packs "9.0.20" |> Option.defaultValue "")
    Assert.Contains("ten eleven", trimDocsOn packs "10.0.14" |> Option.defaultValue "")
    Assert.Contains("eleven", trimDocsOn packs "11.0.3-preview.1" |> Option.defaultValue "")
    Assert.Equal(None, trimDocsOn packs "12.0.0")
    Assert.Equal(None, trimDocsOn [] "10.0.14")
