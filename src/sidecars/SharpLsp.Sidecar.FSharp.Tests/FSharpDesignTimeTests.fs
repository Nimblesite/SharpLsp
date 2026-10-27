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
open System.Threading.Tasks
open System.Xml.Linq
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.Common

/// `<Name>` holding `children`: the project is built as XML, never spliced as text.
let private element (name: string) (children: obj list) = XElement(XName.Get name, Array.ofList children)

let private includes (path: string) =
    element "Compile" [ XAttribute(XName.Get "Include", path) ]

/// Write `<Name>.fsproj` into `dir` with `properties`, a globbed `Src/*.fs` and `extra`.
let private writeProject (dir: string) (name: string) (properties: obj list) (extra: obj list) =
    Directory.CreateDirectory(NativePaths.Resolve(dir, "Src")) |> ignore

    let project =
        element
            "Project"
            ([ XAttribute(XName.Get "Sdk", "Microsoft.NET.Sdk") :> obj
               element "PropertyGroup" properties
               element "ItemGroup" [ includes "Src/*.fs" ] ]
             @ extra)

    let path = NativePaths.Resolve(dir, $"{name}.fsproj")
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

/// Run the dotnet CLI in `dir`; the test fails when it does.
let internal dotnet (dir: string) (args: string) =
    match Process.Start(ProcessStartInfo("dotnet", args, WorkingDirectory = dir, RedirectStandardOutput = true)) with
    | null -> failwith $"dotnet {args} did not start"
    | started ->
        use proc = started
        let output = proc.StandardOutput.ReadToEnd()
        proc.WaitForExit()
        Assert.True((proc.ExitCode = 0), $"dotnet {args} failed: {output}")

/// A restored `net48;net10.0` project holding `source`; its directory, project file and probe.
let private restoredProbeFor properties (source: string) =
    let dir = NativePaths.Temp($"sharplsp-fx-dt-{Guid.NewGuid():N}")
    let fsproj = writeFsproj dir "Probe" properties
    let probe = NativePaths.Resolve(dir, "Src", "Probe.fs")
    // CRLF, as a Windows checkout writes it: a `#if` line's `\r` must not hide the dead branch.
    File.WriteAllText(probe, source.Replace("\n", "\r\n"))
    dotnet dir $"restore \"{fsproj}\" --nologo -v q"
    dir, fsproj, probe

let private restoredProbeOf source = restoredProbeFor [ frameworks "net48;net10.0" ] source

let private restoredProbe () = restoredProbeOf probeSource

let private hoverNames (state: FSharpWorkspace.FSharpWorkspaceState) probe (line: int, column: int) =
    task {
        let! hover = FSharpWorkspace.getHover state probe line column
        return hover |> Option.map (fun (markdown, _, _, _, _) -> markdown)
    }

let private ok (result: Result<'T, string>) =
    match result with
    | Ok value -> value
    | Error reason -> failwith reason

/// SDK compile items and references must retain true errors and reject unavailable APIs. [DIAG-CATEGORIES-COMPILER]
let private assertSingleTargetErrors (state: FSharpWorkspace.FSharpWorkspaceState) (options: FSharp.Compiler.CodeAnalysis.FSharpProjectOptions) missing = task {
    let! results = state.Checker.ParseAndCheckProject(options) |> Async.StartAsTask
    let errors = results.Diagnostics |> Array.filter (fun error -> error.Severity = FSharp.Compiler.Diagnostics.FSharpDiagnosticSeverity.Error)
    Assert.Equal((if missing then 2 else 1), errors.Length)
    Assert.Contains(errors, fun error -> error.ErrorNumber = 1)
    Assert.Equal(missing, errors |> Array.exists (fun error -> error.ErrorNumber = 39))
}

[<Theory>]
[<InlineData("net10.0", "--define:NET10_0", false)>]
[<InlineData("netstandard2.1", "--define:NETSTANDARD2_1", true)>]
let ``single-target projects use the SDK compile items and framework references`` framework define missing = task {
    let source = "module Fx.Probe\nlet unrelated: int = \"broken\"\nlet gate = new System.Threading.Lock()\n"
    let dir, fsproj, probe = restoredProbeFor [ element "TargetFramework" [ framework ] ] source
    try
        let state = FSharpWorkspace.create ()
        let! entry = FSharpDesignTime.loadEntry state.Checker (FSharpWorkspace.buildProjectOptions state) fsproj CancellationToken.None
        Assert.Contains(probe, entry.Options.SourceFiles)
        Assert.Contains(define, entry.Options.OtherOptions)
        Assert.Equal(Some framework, FSharpDesignTime.builtFramework entry)
        do! assertSingleTargetErrors state entry.Options missing
    finally
        cleanup dir
}

[<Fact>]
let ``only a project file that declares TargetFrameworks is evaluated`` () =
    let dir = NativePaths.Temp($"sharplsp-fx-decl-{Guid.NewGuid():N}")

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
        Assert.All(entry.Options.SourceFiles, fun source -> Assert.True(NativePaths.IsRooted source, source))
        Assert.True(entry.Options.SourceFiles.Length > 1, "MSBuild's generated sources are compiled")
        Assert.Contains("--define:NETFRAMEWORK", entry.Options.OtherOptions)
        Assert.Contains("--targetprofile:mscorlib", entry.Options.OtherOptions)
        let output = entry.Options.OtherOptions |> Array.find (fun arg -> arg.StartsWith("-o:"))
        Assert.True(NativePaths.IsRooted(output.Substring 3), $"a relative output resolves against the project: {output}")

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
        let! loaded = FSharpWorkspaceLoading.loadProject state dir
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
        let! _ = FSharpWorkspaceLoading.loadProject state dir
        let! unknown = FSharpTargetFrameworks.switch state probe "net99.0" CancellationToken.None

        match unknown with
        | Error reason -> Assert.Contains("net99.0 is not a target framework of Probe.fsproj", reason)
        | Ok _ -> failwith "an undeclared framework must be refused"

        let foreign = NativePaths.Resolve(dir, "Elsewhere.fs")

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
    let dir = NativePaths.Temp($"sharplsp-fx-fallback-{Guid.NewGuid():N}")

    try
        let lone = writeFsproj (NativePaths.Resolve(dir, "Lone")) "Lone" [ frameworks "net10.0" ]
        let unbuildable = writeFsproj (NativePaths.Resolve(dir, "Future")) "Future" [ frameworks "net99.0;net10.0" ]
        let missing = element "Import" [ XAttribute(XName.Get "Project", "missing.props") ]
        let broken = writeProject (NativePaths.Resolve(dir, "Broken")) "Broken" [ frameworks "net48;net10.0" ] [ missing ]

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

/// The same unchanged text answers from whichever framework is active NOW: a check
/// the checker remembered from the previous framework must not answer for the new one.
[<Fact>]
let ``completion on unchanged text follows the switch: File.WriteAllTextAsync only under net10.0`` () = task {
    let source = String.Join("\n", [ "module Fx.Completion"; ""; "let probe () = System.IO.File."; "" ])
    let dir, _, probe = restoredProbeOf source

    try
        let state = FSharpWorkspace.create ()
        let! _ = FSharpWorkspaceLoading.loadProject state dir
        let labels () =
            task {
                let! entries = FSharpCompletion.getCompletions state probe 2 30
                return entries |> List.map _.Label |> Set.ofList
            }

        let! onFramework = labels ()
        Assert.Contains("ReadAllText", onFramework)
        Assert.DoesNotContain("WriteAllTextAsync", onFramework)

        let! _ = FSharpTargetFrameworks.switch state probe "net10.0" CancellationToken.None
        let! onModern = labels ()
        Assert.Contains("WriteAllTextAsync", onModern)
    finally
        cleanup dir
}

/// MSBuild's reason for a failed design-time compile is its ERROR, on one line. A warning
/// printed first — on CI, a state-file race — is not why it failed, and a reason spread
/// over several log lines hid the error from the line that names the project.
[<Fact>]
let ``a failed design-time compile is reported by its error, on one line`` () = task {
    let dir = NativePaths.Temp($"sharplsp-fx-why-{Guid.NewGuid():N}")

    try
        let attribute (name: string) (value: string) = XAttribute(XName.Get name, value) :> obj

        let failsOnPurpose =
            element
                "Target"
                [ attribute "Name" "FailOnPurpose"
                  attribute "BeforeTargets" "CoreCompile"
                  element "Warning" [ attribute "Text" "SharpLsp fixture: a warning printed first" ]
                  element "Error" [ attribute "Text" "SharpLsp fixture: the compile fails on purpose" ] ]

        let fsproj = writeProject dir "Why" [ frameworks "net48;net10.0" ] [ failsOnPurpose ]
        File.WriteAllText(NativePaths.Resolve(dir, "Src", "Why.fs"), "module Why\nlet answer = 42\n")
        dotnet dir $"restore \"{fsproj}\" --nologo -v q"

        let state = FSharpWorkspace.create ()
        let! entry = FSharpDesignTime.loadEntry state.Checker (FSharpWorkspace.buildProjectOptions state) fsproj CancellationToken.None
        Assert.Equal(Some "net48", entry.Active)
        Assert.Empty(entry.ByFramework)

        match! FSharpDesignTime.optionsForFramework state.Checker entry "net10.0" CancellationToken.None with
        | Ok _ -> failwith "the design-time compile fails on purpose"
        | Error reason ->
            Assert.StartsWith("exit ", reason)
            Assert.Contains("SharpLsp fixture: the compile fails on purpose", reason)
            Assert.DoesNotContain("a warning printed first", reason)
            Assert.DoesNotContain("\n", reason)
    finally
        cleanup dir
}

/// Removing a fixture while MSBuild reads it must abandon that build, not await the full timeout.
/// [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-CSHARP-REFERENCES] [DIAG-LSP-REFRESH]
[<Fact>]
let ``a project removed during its design-time build abandons MSBuild immediately`` () = task {
    let dir = NativePaths.Temp($"sharplsp-fx-removed-{Guid.NewGuid():N}")
    Directory.CreateDirectory dir |> ignore

    try
        let attribute name (value: string) = XAttribute(XName.Get name, value) :> obj
        let pause = if OperatingSystem.IsWindows() then "powershell -NoProfile -Command \"Start-Sleep -Seconds 30\"" else "sleep 30"
        let signal = element "Touch" [ attribute "Files" "design-time-started"; attribute "AlwaysCreate" "true" ]
        let execute = element "Exec" [ attribute "Command" pause ]
        let target = element "Target" [ attribute "Name" "SignalDesignTime"; attribute "BeforeTargets" "CoreCompile"; signal; execute ]
        let project = NativePaths.Resolve(dir, "Removed.csproj")
        let document = element "Project" [ attribute "Sdk" "Microsoft.NET.Sdk"; element "PropertyGroup" [ element "TargetFramework" [ "net10.0" ] ]; target ]
        XDocument(document).Save(project)
        File.WriteAllText(NativePaths.Resolve(dir, "Library.cs"), "public static class Library { }")
        dotnet dir $"restore \"{project}\" --nologo -v q"
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds 8.0)
        let building = FSharpDesignTime.compilerArgs "CscCommandLineArgs" project "net10.0" timeout.Token
        let marker = NativePaths.Resolve(dir, "design-time-started")

        while not (File.Exists marker) && not timeout.IsCancellationRequested do
            do! Task.Delay 20

        Assert.True(File.Exists marker, "the real design-time target started")
        File.Delete project
        let! result = building
        Assert.Equal(Error "MSBuild project was removed during the design-time build", result)
    finally
        if Directory.Exists dir then cleanup dir
}

/// A real SDK failure is limited to one framework; restore remains available. [DIAG-TRUTH-GUARANTEES]
let private failDiagnosticContext dir =
    let attribute name (value: string) = XAttribute(XName.Get name, value) :> obj
    let failure = element "Error" [ attribute "Code" "SLSPTEST1001"; attribute "Text" "SDK context unavailable" ]
    let target = element "Target" [ attribute "Name" "FailDiagnosticContext"
                                    attribute "BeforeTargets" "CoreCompile"
                                    attribute "Condition" "'$(DesignTimeBuild)' == 'true' and '$(TargetFramework)' == 'net48'"
                                    failure ]
    XDocument(element "Project" [ target ]).Save(NativePaths.Resolve(dir, "Directory.Build.targets"))

/// Real peers share imported targets but retain independent SDK compiler identities.
let private diagnosticPeers () =
    let source = "module Contexts\nlet value: int = \"broken\"\n"
    let dir, project, probe = restoredProbeFor [ frameworks "net48;net10.0" ] source
    let declared = XDocument.Load project
    (declared.Descendants(XName.Get "Compile") |> Seq.exactlyOne).SetAttributeValue(XName.Get "Include", "Src/Probe.fs")
    declared.Save project
    let peer = writeFsproj (NativePaths.Resolve(dir, "Independent")) "Independent" [ element "TargetFramework" [ "net10.0" ] ]
    let peerSource = NativePaths.Resolve(NativePaths.DirectoryOf peer, "Src", "Probe.fs")
    File.WriteAllText(peerSource, source)
    dotnet dir $"restore \"{peer}\" --nologo -v q"
    dotnet dir "new sln --format slnx --name Contexts"
    dotnet dir $"sln Contexts.slnx add \"{project}\" \"{peer}\""
    failDiagnosticContext dir
    dir, project, probe, peer, peerSource

let private assertUnavailableContext result =
    match result with
    | Error reason -> Assert.Contains("SLSPTEST1001", reason)
    | Ok _ -> Assert.Fail("An unavailable SDK context cannot authorize compiler findings.")

/// Exercise the actual diagnostic boundary with compiler findings and no analyzer substitutions.
let private contextFindings state path =
    FSharpDiagnosticQueries.get
        { Workspace = state; AnalyzersEnabled = false; Analyzers = FSharpAnalyzers.AnalyzerConfig.Default
          NotifyScopeChanged = fun _ _ -> System.Threading.Tasks.Task.FromResult true }
        path CancellationToken.None

let private assertContextCompilerError state path = task {
    let! findings = contextFindings state path
    let errors = ok findings |> Array.filter (fun finding -> finding.Severity = "Error")
    let finding = Assert.Single errors
    Assert.Equal("FS0001", finding.Code)
    Assert.True(NativePaths.AreEqual(path, finding.FilePath))
    Assert.True(finding.StartLine >= 0 && finding.EndLine >= finding.StartLine)
}

let private assertUnavailableOwner state project probe = task {
    let! findings = contextFindings state probe
    assertUnavailableContext findings
    let! projectFindings = FSharpProjectDiagnostics.getDiagnostics state project CancellationToken.None
    assertUnavailableContext projectFindings
    Assert.True(FSharpDiagnosticInputs.project state project |> Result.isError)
}

/// Failure and repair must not suppress unrelated owners or overwrite a good active context.
let private diagnosticContextCycle state project probe peerSource = task {
    do! assertUnavailableOwner state project probe
    do! assertContextCompilerError state peerSource
    let! switched = FSharpTargetFrameworks.switch state probe "net10.0" CancellationToken.None
    Assert.Equal("net10.0", string (ok switched).Active)
    do! assertContextCompilerError state probe
    do! assertContextCompilerError state peerSource
    let! rejected = FSharpTargetFrameworks.switch state probe "net48" CancellationToken.None
    assertUnavailableContext rejected
    Assert.Equal("net10.0", string (ok (FSharpTargetFrameworks.current state probe)).Active)
    do! assertContextCompilerError state probe
}

[<Fact>]
let ``SDK failures remain scoped and framework switching restores trustworthy diagnostics`` () = task {
    let dir, project, probe, peer, peerSource = diagnosticPeers ()
    try
        let state = FSharpWorkspace.create ()
        let! loaded = FSharpWorkspaceLoading.loadProject state (NativePaths.Resolve(dir, "Contexts.slnx"))
        ok loaded
        Assert.Equal(2, state.Projects.Count)
        Assert.True(FSharpDiagnosticInputs.project state peer |> Result.isOk)
        do! diagnosticContextCycle state project probe peerSource
    finally
        cleanup dir
}
