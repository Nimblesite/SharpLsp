/// How a real .fsproj on disk becomes the FCS command line.
///
/// Every assertion here is about a flag the F# compiler actually receives, because
/// a wrong compiler line is invisible until completions, diagnostics or
/// cross-language go-to-definition quietly stop working:
///   * `<OtherFlags>` must reach FCS, minus any MSBuild property MSBuild never
///     expanded (the XML reader sees `$(Foo)` literally and must drop it);
///   * `<AssemblyName>` that is itself an unexpanded property must NOT become the
///     assembly identity — the project file stem is the honest fallback;
///   * a project that already carries its own `--out:` must not be given a second
///     one; and
///   * a `<ProjectReference>` to a C# project must arrive as `-r:<built dll>`,
///     which is the only reason cross-language navigation resolves at all.
///     Implements [DEFINITION-CROSSLANG].
module SharpLsp.Sidecar.FSharp.Tests.FSharpProjectCrackingTests

open System
open System.IO
open System.Threading
open System.Xml.Linq
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Solutions

let private ok (result: Result<'T, string>) =
    match result with
    | Ok value -> value
    | Error reason -> failwith reason

let private node (name: string) (content: obj array) = XElement(XName.Get name, content)

let private attr (name: string) (value: string) = XAttribute(XName.Get name, value) :> obj

/// A real .fsproj built through XDocument (never string splicing), carrying the
/// supplied `<OtherFlags>` plus an `<AssemblyName>` MSBuild never expanded.
let private writeProject (dir: string) (projectName: string) (otherFlags: string) (extraItems: obj array) =
    Directory.CreateDirectory(dir) |> ignore

    let properties =
        node
            "PropertyGroup"
            [| node "TargetFramework" [| "net10.0" |]
               // MSBuild would expand this; the sidecar's XML reader cannot, so it
               // must refuse the value rather than name the assembly "$(...)".
               node "AssemblyName" [| "$(MSBuildProjectName)" |]
               node "OtherFlags" [| otherFlags |]
               node "DisableImplicitFSharpCoreReference" [| "true" |] |]

    let items =
        node "ItemGroup" (Array.append [| node "Compile" [| attr "Include" "Library.fs" |] |] extraItems)

    let project = node "Project" [| attr "Sdk" "Microsoft.NET.Sdk"; properties; items |]
    let fsproj = NativePaths.Resolve(dir, $"{projectName}.fsproj")
    XDocument(project).Save(fsproj)
    File.WriteAllText(NativePaths.Resolve(dir, "Library.fs"), "module Cracked.Library\n\nlet answer = 42\n")
    fsproj

/// A referenced C# project whose output assembly is already built. The copied
/// file is a genuine managed assembly, so `-r:` names something FCS can open.
let private writeBuiltCsharpReference (root: string) =
    let projectDir = NativePaths.Resolve(root, "Neighbour")
    let outputDir = NativePaths.Resolve(projectDir, "bin", "Debug", "net10.0")
    Directory.CreateDirectory(outputDir) |> ignore
    let csproj = NativePaths.Resolve(projectDir, "Neighbour.csproj")

    XDocument(node "Project" [| attr "Sdk" "Microsoft.NET.Sdk" |]).Save(csproj)

    let assembly = NativePaths.Resolve(outputDir, "Neighbour.dll")
    File.Copy(typeof<SharpLsp.Sidecar.Common.NativePaths>.Assembly.Location, assembly, true)
    assembly

/// Unexpanded MSBuild properties must be dropped, real flags must survive.
let private FLAGS_WITHOUT_OUTPUT = "--nowarn:52 $(UnexpandedExtraFlags) --warnon:1182"

[<Fact>]
let ``cracking a real fsproj carries OtherFlags to FCS and drops unexpanded properties`` () =
    let dir = NativePaths.Temp($"sharplsp-crack-{Guid.NewGuid():N}")

    try
        let fsproj = writeProject dir "CrackedA" FLAGS_WITHOUT_OUTPUT [||]
        let flags = FSharpProjectLoading.parseFsprojOtherFlags fsproj

        Assert.Equal<string array>([| "--nowarn:52"; "--warnon:1182" |], flags)
        Assert.DoesNotContain(flags, fun flag -> flag.StartsWith("$(", StringComparison.Ordinal))
    finally
        cleanup dir

[<Fact>]
let ``an AssemblyName MSBuild never expanded falls back to the project file stem`` () =
    let dir = NativePaths.Temp($"sharplsp-crack-{Guid.NewGuid():N}")

    try
        let fsproj = writeProject dir "CrackedA" FLAGS_WITHOUT_OUTPUT [||]

        // "$(MSBuildProjectName)" is not a usable assembly name; the stem is.
        Assert.Equal("CrackedA", FSharpWorkspace.parseFsprojAssemblyName fsproj)
    finally
        cleanup dir

[<Fact>]
let ``compile items become the FCS source list in declaration order`` () = task {
    let dir = NativePaths.Temp($"sharplsp-crack-{Guid.NewGuid():N}")

    try
        let fsproj = writeProject dir "CrackedA" FLAGS_WITHOUT_OUTPUT [||]
        let state = FSharpWorkspace.create ()
        let! evaluated = FSharpWorkspace.compileSources state fsproj CancellationToken.None
        let sources = ok evaluated

        Assert.Equal(1, sources.Length)
        Assert.Equal(NativePaths.Resolve(dir, "Library.fs"), sources[0])
        // Source paths must be absolute — FCS resolves nothing relative to cwd.
        Assert.True(NativePaths.IsRooted(sources[0]))
    finally
        cleanup dir
}

[<Fact>]
let ``framework reference args pin the runtime instead of the desktop profile`` () =
    let args = FSharpProjectLoading.frameworkReferenceArgs ()

    Assert.Contains("--noframework", args)
    Assert.Contains("--targetprofile:netcore", args)
    // Without FSharp.Core on the line, every fixture would fail to typecheck.
    Assert.Contains(args, fun arg -> NativePaths.NameOf arg = "FSharp.Core.dll")

[<Fact>]
let ``a referenced C# project arrives on the compiler line as its built assembly`` () = task {
    let dir = NativePaths.Temp($"sharplsp-crack-{Guid.NewGuid():N}")

    try
        Directory.CreateDirectory(dir) |> ignore
        let neighbour = writeBuiltCsharpReference dir

        let fsproj =
            writeProject
                dir
                "CrackedA"
                FLAGS_WITHOUT_OUTPUT
                [| node "ProjectReference" [| attr "Include" "Neighbour/Neighbour.csproj" |] |]

        let state = FSharpWorkspace.create ()
        let! options = FSharpWorkspace.buildProjectOptions state fsproj CancellationToken.None

        // [DEFINITION-CROSSLANG]: the C# project is invisible to FCS except as
        // this metadata reference.
        Assert.Contains($"-r:{neighbour}", options.OtherOptions)
        // The project's own OtherFlags survive alongside the reference.
        Assert.Contains("--nowarn:52", options.OtherOptions)
        // No <OtherFlags> output flag, so the cracker stamps the identity itself.
        Assert.Contains("--out:CrackedA.dll", options.OtherOptions)
        Assert.Equal<string array>([| NativePaths.Resolve(dir, "Library.fs") |], options.SourceFiles)
    finally
        cleanup dir
}

[<Fact>]
let ``a project that declares its own output flag is not given a second one`` () = task {
    let dir = NativePaths.Temp($"sharplsp-crack-{Guid.NewGuid():N}")

    try
        let fsproj = writeProject dir "CrackedB" "--nowarn:52 --out:Custom.dll" [||]
        let state = FSharpWorkspace.create ()
        let! options = FSharpWorkspace.buildProjectOptions state fsproj CancellationToken.None

        Assert.Contains("--out:Custom.dll", options.OtherOptions)
        // Two `--out:` flags make the last one win, silently renaming the
        // assembly the project asked for.
        let outputFlags =
            options.OtherOptions
            |> Array.filter (fun flag -> flag.StartsWith("--out:", StringComparison.OrdinalIgnoreCase))

        Assert.Equal<string array>([| "--out:Custom.dll" |], outputFlags)
        Assert.DoesNotContain("--out:CrackedB.dll", options.OtherOptions)
    finally
        cleanup dir
}

[<Fact>]
let ``a lowercase short output flag also suppresses the generated identity`` () = task {
    let dir = NativePaths.Temp($"sharplsp-crack-{Guid.NewGuid():N}")

    try
        let fsproj = writeProject dir "CrackedC" "-o:Short.dll" [||]
        let state = FSharpWorkspace.create ()
        let! options = FSharpWorkspace.buildProjectOptions state fsproj CancellationToken.None

        Assert.Contains("-o:Short.dll", options.OtherOptions)
        Assert.DoesNotContain("--out:CrackedC.dll", options.OtherOptions)
    finally
        cleanup dir
}

[<Fact>]
let ``hand-built options name each source once, so FCS never sees a file twice`` () = task {
    let dir = NativePaths.Temp($"sharplsp-crack-{Guid.NewGuid():N}")

    try
        let fsproj = writeProject dir "CrackedD" "--nowarn:52" [||]
        let state = FSharpWorkspace.create ()
        let! options = FSharpWorkspace.buildProjectOptions state fsproj CancellationToken.None
        let library = NativePaths.Resolve(dir, "Library.fs")

        // Sources belong in SourceFiles alone: FCS compiles every bare argument it
        // finds in OtherOptions as a source too.
        Assert.Equal<string array>([| library |], options.SourceFiles)
        Assert.DoesNotContain(library, options.OtherOptions)
        Assert.All(options.OtherOptions, fun option -> Assert.StartsWith("-", option))

        let checkedProject = state.Checker.ParseAndCheckProject(options) |> Async.RunSynchronously

        // FS3551: "The source file ... already appeared in the compilation list".
        Assert.DoesNotContain(checkedProject.Diagnostics, fun diagnostic -> diagnostic.ErrorNumber = 3551)
        Assert.Empty(checkedProject.Diagnostics)
    finally
        cleanup dir
}

/// Completed editor saves must be visible without denying the editor's write handle.
/// Implements [DIAG-LSP-REFRESH] and [DIAG-TRUTH-GUARANTEES].
let private saveAssemblyName (document: XDocument) (editor: FileStream) name =
    let assembly = document.Descendants(XName.Get "AssemblyName") |> Seq.exactlyOne
    assembly.Value <- name
    editor.Position <- 0L
    editor.SetLength 0L
    document.Save editor
    editor.Flush true

/// MSBuild opens a project with read-only sharing, so while an editor holds a write
/// handle the SDK evaluation is either exact or refused in MSBuild's own words
/// (Windows: MSB4025) — never stale or partial items. [DIAG-TRUTH-GUARANTEES]
let private assertExactOrRefused project source (evaluated: Result<string array, string>) =
    match evaluated with
    | Ok items -> Assert.Equal<string array>([| source |], items)
    | Error reason ->
        Assert.Contains("MSB4025", reason)
        Assert.Contains(NativePaths.NameOf project, reason)

/// Compiler inputs retain exact sources, flags, framework shape and cross-language identity.
let private assertEditableInputs state root project name = task {
    let source = NativePaths.Resolve(root, "Library.fs")
    let reference = NativePaths.Resolve(root, "Neighbour", "Neighbour.csproj")
    let! evaluated = FSharpWorkspace.compileSources state project CancellationToken.None
    assertExactOrRefused project source evaluated
    Assert.Equal<string array>([| "--nowarn:52"; "--warnon:1182" |], FSharpProjectLoading.parseFsprojOtherFlags project)
    Assert.Equal(name, FSharpWorkspace.parseFsprojAssemblyName project)
    Assert.False(FSharpDesignTime.declaresTargetFrameworks project)
    Assert.Equal<string array>([| reference |], ProjectReferences.ReadReferencedProjects(project) |> Seq.toArray)
    Assert.Equal(name, ProjectReferences.AssemblyNameOf project)
}

[<Fact>]
let ``project metadata remains accurate across editor saves with a write handle open`` () = task {
    let root = NativePaths.Temp($"sharplsp-crack-{Guid.NewGuid():N}")
    try
        writeBuiltCsharpReference root |> ignore
        let items: obj array = [| node "ProjectReference" [| attr "Include" "Neighbour/Neighbour.csproj" |] |]
        let project = writeProject root "Editable" FLAGS_WITHOUT_OUTPUT items
        let document = XDocument.Load project
        let state = FSharpWorkspace.create ()
        do! task {
            use editor = File.Open(project, FileMode.Open, FileAccess.Write, FileShare.ReadWrite ||| FileShare.Delete)
            for name in [| "SavedFirst"; "SavedSecond"; "SavedThird" |] do
                saveAssemblyName document editor name
                do! assertEditableInputs state root project name
        }
        // Released, the same workspace evaluates the saved project exactly: a refusal
        // under the editor's handle was never cached.
        let! released = FSharpWorkspace.compileSources state project CancellationToken.None
        Assert.Equal<string array>([| NativePaths.Resolve(root, "Library.fs") |], ok released)
    finally
        cleanup root
}

/// "Add F# Source File" edits the project, and the Solution Explorer asks for its
/// Compile items straight away, before any reload. The cached evaluation must not
/// answer for the project it replaced, and an item outside the project folder is
/// resolved like any other (#493). [SE-FSHARP-SYMBOLS]
[<Fact>]
let ``an edited project is evaluated afresh without waiting for a reload`` () = task {
    let root = NativePaths.Temp($"sharplsp-crack-{Guid.NewGuid():N}")
    try
        let dir = NativePaths.Resolve(root, ".vscode")
        let project = writeProject dir "Edited" FLAGS_WITHOUT_OUTPUT [||]
        let state = FSharpWorkspace.create ()
        let! first = FSharpWorkspace.compileSources state project CancellationToken.None
        Assert.Equal<string array>([| NativePaths.Resolve(dir, "Library.fs") |], ok first)

        let linked = NativePaths.Resolve(root, "Source", "Extra.fs")
        Directory.CreateDirectory(NativePaths.DirectoryOf linked) |> ignore
        File.WriteAllText(linked, "module Extra\n")
        let stamp = File.GetLastWriteTimeUtc project
        writeProject dir "Edited" FLAGS_WITHOUT_OUTPUT [| node "Compile" [| attr "Include" "../Source/Extra.fs" |] |] |> ignore
        File.SetLastWriteTimeUtc(project, stamp.AddSeconds 2.0)
        let! edited = FSharpWorkspace.compileSources state project CancellationToken.None
        Assert.Equal<string array>([| NativePaths.Resolve(dir, "Library.fs"); linked |], ok edited)

        let! again = FSharpWorkspace.compileSources state project CancellationToken.None
        Assert.Same(ok edited, ok again)
    finally
        cleanup root
}
