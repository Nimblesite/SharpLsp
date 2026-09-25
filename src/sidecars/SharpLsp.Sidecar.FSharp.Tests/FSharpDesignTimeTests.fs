/// A multi-targeted F# project compiles per framework with MSBuild's own command
/// line — defines, references and globbed sources — and answers from its first
/// framework until the whole project is switched. Every project here is real: it
/// is written, restored and evaluated by the dotnet CLI.
/// Implements [NETFX-PROJECTS-FSHARP] and [NETFX-CONTEXT].
module SharpLsp.Sidecar.FSharp.Tests.FSharpDesignTimeTests

open System
open System.Diagnostics
open System.IO
open System.Threading
open System.Xml.Linq
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests

/// `<Name>` holding `children`: the project is built as XML, never spliced as text.
let private element (name: string) (children: obj list) = XElement(XName.Get name, Array.ofList children)

let private includes (path: string) =
    element "Compile" [ XAttribute(XName.Get "Include", path) ]

/// Write `<Name>.fsproj` into `dir` with `properties`, a globbed `Src/*.fs` and `extra`.
let private writeProject (dir: string) (name: string) (properties: obj list) (extra: obj list) =
    Directory.CreateDirectory(Path.Combine(dir, "Src")) |> ignore

    let project =
        element
            "Project"
            ([ XAttribute(XName.Get "Sdk", "Microsoft.NET.Sdk") :> obj
               element "PropertyGroup" properties
               element "ItemGroup" [ includes "Src/*.fs" ] ]
             @ extra)

    let path = Path.Combine(dir, $"{name}.fsproj")
    XDocument(project).Save(path)
    path

let private writeFsproj dir name properties = writeProject dir name properties []

/// The probe: one binding per `#if` branch, so the active framework decides which exists.
/// Both branches use `shared`, which IS compiled: a name lookup inside the dead branch
/// would find it, so only the dead branch's own inactivity keeps its hover empty.
let private probeSource =
    String.Join(
        "\n",
        [ "module Fx.Probe"
          ""
          "let shared = \"shared\""
          ""
          "#if NETFRAMEWORK"
          "let onFramework = shared"
          "#else"
          "let onModern = shared"
          "#endif"
          "" ]
    )

/// Line and column of `onFramework`, `onModern`, and `shared` in each branch.
let private onFramework, onModern, sharedInFramework, sharedInModern = (5, 6), (7, 6), (5, 20), (7, 17)

let private frameworks (value: string) = element "TargetFrameworks" [ value ]

let private dotnet (dir: string) (args: string) =
    match Process.Start(ProcessStartInfo("dotnet", args, WorkingDirectory = dir, RedirectStandardOutput = true)) with
    | null -> failwith $"dotnet {args} did not start"
    | started ->
        use proc = started
        let output = proc.StandardOutput.ReadToEnd()
        proc.WaitForExit()
        Assert.True((proc.ExitCode = 0), $"dotnet {args} failed: {output}")

/// A restored `net48;net10.0` project; returns its directory, project file and probe.
let private restoredProbe () =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-fx-dt-{Guid.NewGuid():N}")
    let fsproj = writeFsproj dir "Probe" [ frameworks "net48;net10.0" ]
    let probe = Path.Combine(dir, "Src", "Probe.fs")
    File.WriteAllText(probe, probeSource)
    dotnet dir $"restore \"{fsproj}\" --nologo -v q"
    dir, fsproj, probe

let private hoverNames (state: FSharpWorkspace.FSharpWorkspaceState) probe (line: int, column: int) =
    task {
        let! hover = FSharpWorkspace.getHover state probe line column
        return hover |> Option.map (fun (markdown, _, _, _, _) -> markdown)
    }

let private ok (result: Result<'T, string>) =
    match result with
    | Ok value -> value
    | Error reason -> failwith reason

[<Fact>]
let ``only a project file that declares TargetFrameworks is evaluated`` () =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-fx-decl-{Guid.NewGuid():N}")

    try
        let multi = writeFsproj dir "Multi" [ frameworks "net48;net10.0" ]
        let single = writeFsproj dir "Single" [ element "TargetFramework" [ "net10.0" ] ]
        Assert.True(FSharpDesignTime.declaresTargetFrameworks multi)
        Assert.False(FSharpDesignTime.declaresTargetFrameworks single)
    finally
        cleanup dir

[<Fact>]
let ``the design-time compile of each framework carries that framework's defines and globbed sources`` () = task {
    let dir, fsproj, probe = restoredProbe ()

    try
        let! evaluated = FSharpDesignTime.evaluateTargetFrameworks fsproj CancellationToken.None
        Assert.Equal<string list>([ "net48"; "net10.0" ], ok evaluated)

        let state = FSharpWorkspace.create ()
        let! entry = FSharpDesignTime.loadEntry state.Checker (FSharpWorkspace.buildProjectOptions state) fsproj CancellationToken.None
        Assert.Equal<string list>([ "net48"; "net10.0" ], entry.Frameworks)
        Assert.Equal(Some "net48", entry.Active)
        // The glob is MSBuild's to expand; its generated attribute sources compile too.
        Assert.Contains(probe, entry.Options.SourceFiles)
        Assert.All(entry.Options.SourceFiles, fun source -> Assert.True(Path.IsPathRooted source, source))
        Assert.True(entry.Options.SourceFiles.Length > 1, "MSBuild's generated sources are compiled")
        Assert.Contains("--define:NETFRAMEWORK", entry.Options.OtherOptions)
        Assert.Contains("--targetprofile:mscorlib", entry.Options.OtherOptions)
        let output = entry.Options.OtherOptions |> Array.find (fun arg -> arg.StartsWith("-o:"))
        Assert.True(Path.IsPathRooted(output.Substring 3), $"a relative output resolves against the project: {output}")

        let! modern = FSharpDesignTime.optionsForFramework state.Checker entry "net10.0" CancellationToken.None
        Assert.DoesNotContain("--define:NETFRAMEWORK", (ok modern).OtherOptions)
        Assert.Contains("--targetprofile:netcore", (ok modern).OtherOptions)
        let! again = FSharpDesignTime.optionsForFramework state.Checker entry "net10.0" CancellationToken.None
        Assert.Same(ok modern, ok again)
    finally
        cleanup dir
}

[<Fact>]
let ``a project answers from its first framework until the whole project is switched`` () = task {
    let dir, fsproj, probe = restoredProbe ()

    try
        let state = FSharpWorkspace.create ()
        let! loaded = FSharpWorkspace.loadProject state dir
        Assert.Equal(Ok(), loaded)

        let context = ok (FSharpTargetFrameworks.current state probe)
        Assert.Equal("net48", string context.Active)
        Assert.Equal<string seq>([ "net48"; "net10.0" ], context.Available)
        Assert.Equal(fsproj, string context.Project)
        let! framework = hoverNames state probe onFramework
        Assert.Contains("onFramework", framework.Value)
        let! live = hoverNames state probe sharedInFramework
        Assert.Contains("shared", live.Value)
        let! inert = hoverNames state probe onModern
        Assert.True(inert.IsNone, "code an inactive #if branch holds must not resolve")
        let! inertShared = hoverNames state probe sharedInModern
        Assert.True(inertShared.IsNone, "not even a name the active branch does compile")

        let! switched = FSharpTargetFrameworks.switch state probe "net10.0" CancellationToken.None
        Assert.Equal("net10.0", string (ok switched).Active)
        Assert.Equal("net10.0", string (ok (FSharpTargetFrameworks.current state probe)).Active)
        let! modern = hoverNames state probe onModern
        Assert.Contains("onModern", modern.Value)
        let! nowInert = hoverNames state probe onFramework
        Assert.True(nowInert.IsNone, "the .NET Framework branch is dead under net10.0")
        let! nowInertShared = hoverNames state probe sharedInFramework
        Assert.True(nowInertShared.IsNone, "and so is its use of shared")
    finally
        cleanup dir
}

[<Fact>]
let ``an undeclared framework fails by name, and a file no project compiles has none`` () = task {
    let dir, _, probe = restoredProbe ()

    try
        let state = FSharpWorkspace.create ()
        let! _ = FSharpWorkspace.loadProject state dir
        let! unknown = FSharpTargetFrameworks.switch state probe "net99.0" CancellationToken.None

        match unknown with
        | Error reason -> Assert.Contains("net99.0 is not a target framework of Probe.fsproj", reason)
        | Ok _ -> failwith "an undeclared framework must be refused"

        let foreign = Path.Combine(dir, "Elsewhere.fs")

        let none = ok (FSharpTargetFrameworks.current state foreign)
        Assert.Null(none.Active)
        Assert.Empty(none.Available)
        Assert.Null(none.Project)

        let! foreignSwitch = FSharpTargetFrameworks.switch state foreign "net48" CancellationToken.None
        Assert.True(Result.isError foreignSwitch)
        Assert.Equal("net48", string (ok (FSharpTargetFrameworks.current state probe)).Active)
    finally
        cleanup dir
}

[<Fact>]
let ``a lone framework, a framework MSBuild cannot compile, and a broken evaluation all keep the Compile items`` () = task {
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-fx-fallback-{Guid.NewGuid():N}")

    try
        let lone = writeFsproj (Path.Combine(dir, "Lone")) "Lone" [ frameworks "net10.0" ]
        let unbuildable = writeFsproj (Path.Combine(dir, "Future")) "Future" [ frameworks "net99.0;net10.0" ]
        let missing = element "Import" [ XAttribute(XName.Get "Project", "missing.props") ]
        let broken = writeProject (Path.Combine(dir, "Broken")) "Broken" [ frameworks "net48;net10.0" ] [ missing ]

        let state = FSharpWorkspace.create ()
        let load path = FSharpDesignTime.loadEntry state.Checker (FSharpWorkspace.buildProjectOptions state) path CancellationToken.None
        let! loneEntry = load lone
        Assert.Empty(loneEntry.Frameworks)
        Assert.Equal(None, loneEntry.Active)

        let! futureEntry = load unbuildable
        Assert.Equal<string list>([ "net99.0"; "net10.0" ], futureEntry.Frameworks)
        Assert.Equal(Some "net99.0", futureEntry.Active)
        Assert.Empty(futureEntry.ByFramework)

        let! brokenEntry = load broken
        Assert.Empty(brokenEntry.Frameworks)
        let! cancelled = FSharpDesignTime.evaluateTargetFrameworks lone (CancellationToken(true))
        Assert.Equal(Error "MSBuild did not finish in time", cancelled)
    finally
        cleanup dir
}
