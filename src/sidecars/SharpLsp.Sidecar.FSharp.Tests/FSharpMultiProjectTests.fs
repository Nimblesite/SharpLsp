/// A workspace of several F# projects, one referencing another, is analyzed as one:
/// each file answers from its own project, a referenced F# project is read from its
/// CURRENT source — never a DLL, so nothing here is ever built — and every
/// project-wide query counts what every project does (GitHub #165).
/// Implements [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES].
module SharpLsp.Sidecar.FSharp.Tests.FSharpMultiProjectTests

open System
open System.IO
open System.Xml.Linq
open FSharp.Compiler.Diagnostics
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests

/// `Core`, its function named `name`: the function at line 3, an interface at line 5 (0-based).
let private coreDefining (name: string) =
    String.Join(
        "\n",
        [ "module Core.Geometry"
          ""
          "/// The area of a square."
          $"let {name} (side: float) = side * side"
          ""
          "type IShape ="
          "    abstract Area: float"
          "" ]
    )

let private coreSource = coreDefining "area"

/// `Core` with `area` renamed, as an unsaved buffer.
let private coreRenamed = coreDefining "squareArea"

/// `App`: uses `area` at lines 4 and 8, implements `IShape` at line 7 (0-based).
let private appSource =
    String.Join(
        "\n",
        [ "module App.Program"
          ""
          "open Core.Geometry"
          ""
          "let total = area 3.0"
          ""
          "type Square(side: float) ="
          "    interface IShape with"
          "        member _.Area = area side"
          "" ]
    )

let private element (name: string) (children: obj list) =
    XElement(XName.Get name, Array.ofList children) :> obj

let private attribute (name: string) (value: string) = XAttribute(XName.Get name, value) :> obj

/// `root/<name>/<name>.fsproj` compiling `source` as `file` and referencing `references`.
let private writeProject root (name: string) file (source: string) (references: string list) =
    let dir = NativePaths.Resolve(root, name)
    Directory.CreateDirectory dir |> ignore

    let items =
        element "Compile" [ attribute "Include" file ]
        :: [ for reference in references -> element "ProjectReference" [ attribute "Include" reference ] ]

    let project =
        element
            "Project"
            [ attribute "Sdk" "Microsoft.NET.Sdk"
              element
                  "PropertyGroup"
                  [ element "TargetFramework" [ "net10.0" :> obj ]
                    element "DisableImplicitFSharpCoreReference" [ "true" :> obj ] ]
              element "ItemGroup" items ]

    XDocument(project).Save(NativePaths.Resolve(dir, $"{name}.fsproj"))
    let path = NativePaths.Resolve(dir, file)
    File.WriteAllText(path, source)
    path

/// Core and App — App referencing Core — written, never built, and opened as one folder.
let private openSolution () =
    task {
        let root = NativePaths.Temp($"sharplsp-multi-{Guid.NewGuid():N}")
        let core = writeProject root "Core" "Library.fs" coreSource []
        let app = writeProject root "App" "Program.fs" appSource [ NativePaths.Join("..", "Core", "Core.fsproj") ]
        let state = FSharpWorkspace.create ()
        let! loaded = FSharpWorkspace.loadProject state root
        Assert.True(Result.isOk loaded, $"both projects load: {loaded}")
        return state, root, core, app
    }

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

/// Where a use is: its file and 0-based line.
let private place (used: FSharp.Compiler.CodeAnalysis.FSharpSymbolUse) =
    let range = used.Range
    range.FileName, range.StartLine - 1

/// The sorted 0-based lines of `uses` in `file`.
let private linesIn (file: string) (uses: FSharp.Compiler.CodeAnalysis.FSharpSymbolUse array) =
    uses
    |> Array.map place
    |> Array.filter (fun (path, _) -> NativePaths.AreEqual(path, file))
    |> Array.map snd
    |> Array.sort
    |> List.ofArray

[<Fact>]
let ``a project reads the F# project it references from source, never built`` () =
    task {
        let! (state, root, core, app) = openSolution ()

        try
            Assert.False(Directory.Exists(NativePaths.Resolve(root, "Core", "bin")), "Core is never built")
            let! appErrors = errorsIn state app
            Assert.Empty(appErrors)
            let! coreErrors = errorsIn state core
            Assert.Empty(coreErrors)

            let! definition = FSharpWorkspace.getDefinition state app 4 13
            Assert.True(definition.IsSome, "`area` navigates across the project reference")
            Assert.True(NativePaths.AreEqual(core, definition.Value.FilePath), $"into Core's source: {definition}")
            Assert.Equal(3, definition.Value.Line)
            Assert.Equal(4, definition.Value.Character)
        finally
            cleanup root
    }

[<Fact>]
let ``an unsaved edit in the referenced project reaches the project that uses it`` () =
    task {
        let! (state, root, core, app) = openSolution ()

        try
            let! before = errorsIn state app
            Assert.Empty(before)

            FSharpWorkspace.applyDidChange state core coreRenamed
            let! broken = errorsIn state app
            Assert.Equal<int list>([ 4; 8 ], broken |> List.map fst |> List.sort)
            Assert.All(broken, fun (_, message) -> Assert.Contains("area", message))

            FSharpWorkspace.applyDidChange state core coreSource
            let! restored = errorsIn state app
            Assert.Empty(restored)
        finally
            cleanup root
    }

[<Fact>]
let ``references, code lens and subtypes count what every project does`` () =
    task {
        let! (state, root, core, app) = openSolution ()

        try
            let! fromDefinition = FSharpReferences.getProjectUsages state core 3 5
            Assert.Equal<int list>([ 4; 8 ], linesIn app fromDefinition)
            Assert.Equal<int list>([ 3 ], linesIn core fromDefinition)

            let! fromUse = FSharpReferences.getProjectUsages state app 4 13
            Assert.Equal<int list>([ 4; 8 ], linesIn app fromUse)
            Assert.Equal<int list>([ 3 ], linesIn core fromUse)

            let! lenses = FSharpCodeLens.getCodeLenses state core
            let titleAt line = lenses |> List.tryFind (fun lens -> lens.Line = line) |> Option.map _.Title
            Assert.Equal(Some "2 references", titleAt 3)
            Assert.Equal(Some "1 reference", titleAt 5)

            let! subtypes = FSharpHierarchy.subtypes state core 5 6
            let square = subtypes |> List.tryFind (fun item -> item.Name = "Square")
            Assert.True(square.IsSome, $"App's Square implements Core's IShape: {subtypes}")
            Assert.True(NativePaths.AreEqual(app, square.Value.FilePath))
            Assert.Equal(6, square.Value.Line)
        finally
            cleanup root
    }

/// Options for `project` from a compiler command line.
let private commandLine (project: string) (args: string list) =
    (FSharpWorkspace.create ()).Checker.GetProjectOptionsFromCommandLineArgs(project, Array.ofList args)

/// A multi-targeted project's design-time command line already names the build of the
/// referenced project ITS framework compiles against, which need not be that project's
/// own active framework: that reference stands. Hand-built options carry no F# reference,
/// so theirs is wired in memory.
[<Fact>]
let ``a reference MSBuild resolved stands, and one hand-built options drop is wired in memory`` () =
    let root = NativePaths.Temp("sharplsp-graph")
    let shared = commandLine (NativePaths.Resolve(root, "Shared", "Shared.fsproj")) [ "--out:Shared.dll" ]
    let resolvedDll = NativePaths.Resolve(root, "Shared", "bin", "netstandard2.1", "Shared.dll")
    let flip = commandLine (NativePaths.Resolve(root, "Flip", "Flip.fsproj")) [ "--out:Flip.dll"; $"-r:{resolvedDll}" ]
    let app = commandLine (NativePaths.Resolve(root, "App", "App.fsproj")) [ "--out:App.dll" ]
    let current (project: string) = if NativePaths.AreEqual(project, shared.ProjectFileName) then Some shared else None
    let referencesOf (_: string) = [ shared.ProjectFileName ]

    let resolved = FSharpProjectGraph.wire current referencesOf flip
    Assert.Empty(resolved.ReferencedProjects)
    Assert.Equal<string array>(flip.OtherOptions, resolved.OtherOptions)

    let output = FSharpProjectGraph.outputOf shared
    Assert.Equal(NativePaths.Resolve(root, "Shared", "Shared.dll"), output)
    let wired = FSharpProjectGraph.wire current referencesOf app
    Assert.Contains($"-r:{output}", wired.OtherOptions)

    match wired.ReferencedProjects with
    | [| FSharp.Compiler.CodeAnalysis.FSharpReferencedProject.FSharpReference(file, options) |] ->
        Assert.Equal(output, file)
        Assert.Equal(shared.ProjectFileName, options.ProjectFileName)
    | other -> failwith $"exactly one in-memory reference, to Shared: {other}"
