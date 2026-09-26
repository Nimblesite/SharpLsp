/// A multi-targeted F# project compiles with MSBuild's own command line, whose `-r:` names
/// each F# project it references by the assembly of the build MSBuild picked for ITS
/// framework. That build is read in memory under that very `-r:`, never from disk: nothing
/// here is ever built, yet the project checks clean, navigates into the referenced source,
/// sees an unsaved edit there, and keeps the build MSBuild picked when the referenced
/// project switches to another framework (GitHub #165).
/// Implements [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES] and [NETFX-PROJECTS-FSHARP].
module SharpLsp.Sidecar.FSharp.Tests.FSharpResolvedReferenceTests

open System
open System.Diagnostics
open System.IO
open System.Threading
open System.Xml.Linq
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests

/// `Lib`: `answer` (line 2) on every framework, `onFramework` (line 5) only on .NET
/// Framework, `onModern` (line 7) only on .NET. 0-based lines.
let private libSource (answer: string) =
    String.Join(
        "\n",
        [ "module Lib.Api"
          ""
          $"let {answer} = 42"
          ""
          "#if NETFRAMEWORK"
          $"let onFramework = {answer}"
          "#else"
          $"let onModern = {answer}"
          "#endif"
          "" ]
    )

/// `App`: `answer` at column 20 and the framework's own binding at column 37, on line 3
/// under .NET Framework and line 5 under .NET.
let private appSource =
    String.Join(
        "\n",
        [ "module App.Main"
          ""
          "#if NETFRAMEWORK"
          "let total = Lib.Api.answer + Lib.Api.onFramework"
          "#else"
          "let total = Lib.Api.answer + Lib.Api.onModern"
          "#endif"
          "" ]
    )

let private node (name: string) (children: obj list) =
    XElement(XName.Get name, Array.ofList children) :> obj

/// `root/<name>/<name>.fsproj` for `frameworks`, compiling `<name>.fs` and referencing `references`.
let private writeTargeting root (name: string) (frameworks: string) (source: string) (references: string list) =
    let dir = NativePaths.Resolve(root, name)
    let itemOf (item: string) (path: string) = node item [ XAttribute(XName.Get "Include", path) :> obj ]
    Directory.CreateDirectory dir |> ignore

    XDocument(
        node
            "Project"
            [ XAttribute(XName.Get "Sdk", "Microsoft.NET.Sdk") :> obj
              node "PropertyGroup" [ node "TargetFrameworks" [ frameworks :> obj ] ]
              node "ItemGroup" (itemOf "Compile" $"{name}.fs" :: List.map (itemOf "ProjectReference") references) ]
    )
        .Save(NativePaths.Resolve(dir, $"{name}.fsproj"))

    let path = NativePaths.Resolve(dir, $"{name}.fs")
    File.WriteAllText(path, source)
    path

/// `root/<name>/<name>.fsproj` for `net48;net10.0`, compiling `<name>.fs` and referencing `references`.
let private writeMultiTargeted root name (source: string) (references: string list) =
    writeTargeting root name "net48;net10.0" source references

/// Restore `project` with the dotnet CLI; the test fails when restore does.
let private restore (project: string) =
    let info = ProcessStartInfo("dotnet", $"restore \"{project}\" --nologo -v q", RedirectStandardOutput = true)

    match Process.Start info with
    | null -> failwith "dotnet restore did not start"
    | started ->
        use proc = started
        let output = proc.StandardOutput.ReadToEnd()
        proc.WaitForExit()
        Assert.True((proc.ExitCode = 0), $"dotnet restore failed: {output}")

/// Lib and App — App referencing Lib, both `net48;net10.0` — restored, never built, loaded as one folder.
let private openSolution () =
    task {
        let root = NativePaths.Temp($"sharplsp-picked-{Guid.NewGuid():N}")
        let lib = writeMultiTargeted root "Lib" (libSource "answer") []
        let app = writeMultiTargeted root "App" appSource [ NativePaths.Join("..", "Lib", "Lib.fsproj") ]
        restore (NativePaths.Resolve(root, "App", "App.fsproj"))
        let state = FSharpWorkspace.create ()
        let! loaded = FSharpWorkspace.loadProject state root
        Assert.True(Result.isOk loaded, $"both projects load: {loaded}")
        return state, root, lib, app
    }

/// The loaded project that compiles `file`.
let private entryOf (state: FSharpWorkspace.FSharpWorkspaceState) (file: string) =
    state.Projects.Values
    |> Seq.find (fun entry -> entry.Options.SourceFiles |> Array.exists (fun source -> NativePaths.AreEqual(source, file)))

/// The reference to Lib MSBuild resolved for `entry` under `framework`.
let private resolvedLib (entry: FSharpDesignTime.FSharpProjectEntry) (framework: string) =
    entry.Resolved[framework]
    |> List.find (fun reference -> NativePaths.NameOf reference.Project = "Lib.fsproj")

/// The errors FCS reports for `file`, as (0-based line, message).
let private errorsIn state file =
    task {
        let! checkedFile = FSharpWorkspace.checkFile state file

        return
            checkedFile
            |> Option.map (fun (results, _) ->
                results.Diagnostics
                |> Array.filter (fun diagnostic -> diagnostic.Severity = FSharpDiagnosticSeverity.Error)
                |> Array.map (fun diagnostic -> diagnostic.StartLine - 1, diagnostic.Message)
                |> List.ofArray)
            |> Option.defaultValue [ -1, $"{file} was never checked" ]
    }

/// Where `file`'s definition at `line`/`column` lands: its file and 0-based line and column.
let private definitionOf state file line column =
    task {
        let! definition = FSharpWorkspace.getDefinition state file line column
        Assert.True(definition.IsSome, $"({line}, {column}) navigates")
        return definition.Value.FilePath, definition.Value.Line, definition.Value.Character
    }

let private switched (result: Result<SharpLsp.Sidecar.Common.Messages.TargetFrameworkResult, string>) =
    match result with
    | Ok answer -> answer.Active
    | Error reason -> failwith reason

[<Fact>]
let ``a multi-targeted project reads the build MSBuild picked of the F# project it references, never built`` () =
    task {
        let! (state, root, lib, app) = openSolution ()

        try
            Assert.Empty(Directory.GetFiles(root, "Lib.dll", SearchOption.AllDirectories))
            let appEntry = entryOf state app
            Assert.Equal(Some "net48", appEntry.Active)
            let reference = resolvedLib appEntry "net48"
            Assert.Equal("net48", reference.Framework)
            Assert.Contains($"-r:{reference.Assembly}", appEntry.Options.OtherOptions)

            // The build is read in memory under MSBuild's own -r:, and no second -r: is added.
            let wired = (FSharpWorkspace.optionsFor state app).Value
            Assert.Equal<string array>(appEntry.Options.OtherOptions, wired.OtherOptions)

            match wired.ReferencedProjects with
            | [| FSharpReferencedProject.FSharpReference(file, options) |] ->
                Assert.Equal(reference.Assembly, file)
                Assert.True(NativePaths.AreEqual(reference.Project, options.ProjectFileName))
                Assert.Contains("--define:NETFRAMEWORK", options.OtherOptions)
            | other -> failwith $"exactly one in-memory reference, to Lib's net48 build: {other}"

            let! appErrors = errorsIn state app
            Assert.Empty(appErrors)
            let! (file, line, column) = definitionOf state app 3 20
            Assert.True(NativePaths.AreEqual(lib, file), $"`answer` lands in Lib's source: {file}")
            Assert.Equal((2, 4), (line, column))

            // A project-wide query from Lib counts the use App makes through that build.
            let! uses = FSharpReferences.getProjectUsages state lib 2 4
            let place (used: FSharpSymbolUse) =
                let range = used.Range
                range.FileName, range.StartLine - 1

            let linesIn (path: string) =
                uses
                |> Array.map place
                |> Array.filter (fun (used, _) -> NativePaths.AreEqual(used, path))
                |> Array.map snd
                |> Array.sort
                |> List.ofArray

            Assert.Equal<int list>([ 3 ], linesIn app)
            Assert.Equal<int list>([ 2; 5 ], linesIn lib)
        finally
            cleanup root
    }

[<Fact>]
let ``the build MSBuild picked stays through the referenced project's switch, follows an unsaved edit, and changes with the reader's framework`` () =
    task {
        let! (state, root, lib, app) = openSolution ()

        try
            // Lib now answers from net10.0, where onFramework does not exist; App on net48
            // still reads Lib's net48 build, where it does.
            let! libSwitch = FSharpTargetFrameworks.switch state lib "net10.0" CancellationToken.None
            Assert.Equal("net10.0", switched libSwitch)
            let! libErrors = errorsIn state lib
            Assert.Empty(libErrors)
            let! appErrors = errorsIn state app
            Assert.Empty(appErrors)
            let! (file, line, column) = definitionOf state app 3 37
            Assert.True(NativePaths.AreEqual(lib, file), $"`onFramework` lands in Lib's source: {file}")
            Assert.Equal((5, 4), (line, column))

            // An unsaved edit in Lib reaches the build App reads, though Lib answers from another.
            FSharpWorkspace.applyDidChange state lib (libSource "answered")
            let! broken = errorsIn state app
            Assert.Equal<int list>([ 3 ], broken |> List.map fst)
            Assert.All(broken, fun (_, message) -> Assert.Contains("answer", message))
            FSharpWorkspace.applyDidChange state lib (libSource "answer")
            let! restored = errorsIn state app
            Assert.Empty(restored)

            // App on net10.0 reads the build MSBuild picks for net10.0.
            let! appSwitch = FSharpTargetFrameworks.switch state app "net10.0" CancellationToken.None
            Assert.Equal("net10.0", switched appSwitch)
            let reference = resolvedLib (entryOf state app) "net10.0"
            Assert.Equal("net10.0", reference.Framework)
            let! modernErrors = errorsIn state app
            Assert.Empty(modernErrors)
            let! (modernFile, modernLine, modernColumn) = definitionOf state app 5 37
            Assert.True(NativePaths.AreEqual(lib, modernFile), $"`onModern` lands in Lib's source: {modernFile}")
            Assert.Equal((7, 4), (modernLine, modernColumn))
        finally
            cleanup root
    }

/// `Lib` read by `App` on net48 and by three readers whose first framework is net10.0,
/// which read Lib's net10.0 build: six builders, twice what FCS keeps by default.
let private openFanOut () =
    task {
        let root = NativePaths.Temp($"sharplsp-fanout-{Guid.NewGuid():N}")
        let lib = writeMultiTargeted root "Lib" (libSource "answer") []
        let toLib = [ NativePaths.Join("..", "Lib", "Lib.fsproj") ]
        let app = writeMultiTargeted root "App" appSource toLib
        let modern = [ for i in 1..3 -> writeTargeting root $"Modern{i}" "net10.0;net48" appSource toLib ]

        for reader in app :: modern do
            restore (NativePaths.WithExtension(reader, ".fsproj") |> string)

        let state = FSharpWorkspace.create ()
        let! loaded = FSharpWorkspace.loadProject state root
        Assert.True(Result.isOk loaded, $"every project loads: {loaded}")
        return state, root, lib, app, modern
    }

/// The value each project of `scope` declares — `answer` in Lib, `total` in a reader — as
/// the whole-project check holds it NOW. FCS creates the value anew each time it checks the
/// project, so the same value coming back is the builder being reused, not rebuilt.
let private declaredIn state (scope: FSharpProjectOptions list) =
    task {
        let! results = FSharpWorkspace.checkAll state scope

        return
            results
            |> List.map (fun project ->
                project.GetAllUsesOfAllSymbols()
                |> Array.find (fun used -> used.IsFromDefinition && List.contains used.Symbol.DisplayName [ "answer"; "total" ])
                |> fun used -> project.ProjectContext.ProjectOptions.ProjectFileName, used.Symbol)
    }

/// Every reader of Lib is searched, through whichever build of Lib it reads, and the
/// second identical query re-checks NOTHING: FCS keeps one builder per project AND
/// framework, and enough of them for a solution. With FCS's default of three, the six
/// builders here evicted each other and every query re-checked every project from
/// scratch, which is what stalled FsToolkit (CI run 36201579575).
[<Fact>]
let ``a query over many readers checks each once, and the next identical query re-checks nothing`` () =
    task {
        let! (state, root, lib, app, modern) = openFanOut ()

        try
            let titles () =
                task {
                    let! lenses = FSharpCodeLens.getCodeLenses state lib
                    return lenses |> List.map (fun lens -> lens.Line, lens.Title) |> List.sort
                }

            // The module: two uses per reader. `answer`: one per reader and Lib's own on line 5.
            // `onFramework`: App alone compiles the .NET Framework branch that uses it.
            let! first = titles ()
            Assert.Equal<(int * string) list>([ 0, "8 references"; 2, "5 references"; 5, "1 reference" ], first)
            let scope = FSharpWorkspace.queryScope state lib
            Assert.Equal(5, scope.Length)
            let! before = declaredIn state scope

            let! second = titles ()
            Assert.Equal<(int * string) list>(first, second)
            let! uses = FSharpReferences.getProjectUsages state lib 2 4

            let fileOf (used: FSharpSymbolUse) =
                let range = used.Range
                string (NativePaths.NameOf range.FileName)

            let readers = uses |> Array.map fileOf |> Array.distinct |> Array.sort
            Assert.Equal<string array>([| "App.fs"; "Lib.fs"; "Modern1.fs"; "Modern2.fs"; "Modern3.fs" |], readers)
            let! after = declaredIn state scope

            for (project, value), (_, again) in List.zip before after do
                Assert.True(value.Equals again, $"{NativePaths.NameOf project} was checked again by queries that changed nothing")

            // Lib answers from net48 while its readers on net10.0 read another build of it:
            // two builds of one project, each with a project id and a builder of its own.
            let own = (FSharpWorkspace.optionsFor state lib).Value

            let picked =
                (FSharpWorkspace.optionsFor state modern[0]).Value.ReferencedProjects
                |> Array.pick (function
                    | FSharpReferencedProject.FSharpReference(_, options) -> Some options
                    | _ -> None)

            Assert.True(NativePaths.AreEqual(own.ProjectFileName, picked.ProjectFileName))
            Assert.True(own.ProjectId.IsSome && picked.ProjectId.IsSome, "every framework's options carry a project id")
            Assert.NotEqual(own.ProjectId, picked.ProjectId)
            let! appErrors = errorsIn state app
            Assert.Empty(appErrors)
        finally
            cleanup root
    }

/// Options for `project` from a compiler command line.
let private fromCommandLine (project: string) (args: string list) =
    (FSharpWorkspace.create ()).Checker.GetProjectOptionsFromCommandLineArgs(project, Array.ofList args)

[<Fact>]
let ``a build MSBuild picked is read in memory under the -r it wrote, and only one it wrote`` () =
    let root = NativePaths.Temp("sharplsp-picked-graph")
    let picked = NativePaths.Resolve(root, "Shared", "obj", "Debug", "net10.0", "ref", "Shared.dll")
    let shared = fromCommandLine (NativePaths.Resolve(root, "Shared", "Shared.fsproj")) [ "--out:obj/Debug/net10.0/Shared.dll" ]
    let flip = fromCommandLine (NativePaths.Resolve(root, "Flip", "Flip.fsproj")) [ "--out:Flip.dll"; $"-r:{picked}" ]
    let none (_: string) : FSharpProjectOptions option = None
    let noReferences (_: string) : string list = []

    let builtFor (reference: string) (options: FSharpProjectOptions) =
        if obj.ReferenceEquals(options, flip) then
            [ { FSharpProjectGraph.Reference = reference; FSharpProjectGraph.Options = shared } ]
        else
            []

    let wired = FSharpProjectGraph.wireAll none noReferences (builtFor picked) flip
    Assert.Equal<string array>(flip.OtherOptions, wired.OtherOptions)

    match wired.ReferencedProjects with
    | [| FSharpReferencedProject.FSharpReference(file, options) |] ->
        Assert.Equal(picked, file)
        Assert.Same(shared, options)
    | other -> failwith $"exactly one in-memory reference, to Shared's picked build: {other}"

    // A build under a path no -r: of the options names is never read.
    let elsewhere = FSharpProjectGraph.wireAll none noReferences (builtFor (NativePaths.Resolve(root, "Elsewhere.dll"))) flip
    Assert.Same(flip, elsewhere)

    // Knowing nothing of MSBuild's builds, the reference it resolved stands.
    let standing = FSharpProjectGraph.wire none noReferences flip
    Assert.Same(flip, standing)
