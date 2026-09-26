/// An F# project reads the C# projects it references in memory — compiled by Roslyn from
/// MSBuild's design-time command line for the framework MSBuild picked — never from a DLL:
/// nothing here is ever built, yet the project checks clean under each framework,
/// definition lands in the C# source, and a saved C# edit reaches F# without a build. A
/// C# project MSBuild cannot compile leaves the reference on its DLL (GitHub #313).
/// Implements [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-CSHARP-REFERENCES] and [DEFINITION-CROSSLANG].
module SharpLsp.Sidecar.FSharp.Tests.FSharpCSharpReferenceTests

open System
open System.Diagnostics
open System.IO
open System.Threading
open System.Xml.Linq
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open Microsoft.CodeAnalysis.CSharp
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests

/// `Base`: the abstract class `Greeter` derives from, declared at line 2 (0-based).
let private namedSource =
    String.Join(
        "\n",
        [ "namespace Base"
          "{"
          "    public abstract class Named"
          "    {"
          "        public string Name { get { return GetType().Name; } }"
          "    }"
          "}"
          "" ]
    )

/// `Core`: `Greeter` at line 2, `Greet` at line 4, a method whose BODY does not compile
/// at line 5, `OnFramework` at line 7 and `OnModern` at line 9 (0-based).
let private greeterSource (greet: string) =
    String.Join(
        "\n",
        [ "namespace Core"
          "{"
          "    public sealed class Greeter : Base.Named"
          "    {"
          $"        public static string {greet}(string who) {{ return \"Hello \" + who; }}"
          "        public static int Broken() { return \"not an int\"; }"
          "#if NETFRAMEWORK"
          "        public static string OnFramework { get { return \"framework\"; } }"
          "#else"
          "        public static string OnModern { get { return \"modern\"; } }"
          "#endif"
          "    }"
          "}"
          "" ]
    )

/// `App`: `Greeter` at (3, 17), `Greet` at (3, 25), `Name` at (4, 19), and the framework's
/// own property at column 29 of line 6 under .NET Framework, line 8 under .NET.
let private appSource =
    String.Join(
        "\n",
        [ "module App.Main"
          ""
          "let greeter = Core.Greeter()"
          "let hello = Core.Greeter.Greet \"world\""
          "let name = greeter.Name"
          "#if NETFRAMEWORK"
          "let framework = Core.Greeter.OnFramework"
          "#else"
          "let framework = Core.Greeter.OnModern"
          "#endif"
          "" ]
    )

let private node (name: string) (children: obj list) =
    XElement(XName.Get name, Array.ofList children) :> obj

let private attribute (name: string) (value: string) = XAttribute(XName.Get name, value) :> obj

/// `root/<name>/<name>.<extension>` for `frameworks`, compiling `file` and referencing
/// `references`, with `extra` project content.
let private writeProject root (name: string) extension (frameworks: string) file (source: string) (references: string list) (extra: obj list) =
    let dir = NativePaths.Resolve(root, name)
    Directory.CreateDirectory dir |> ignore
    let property = if frameworks.Contains ';' then "TargetFrameworks" else "TargetFramework"
    let itemOf (item: string) (path: string) = node item [ attribute "Include" path ]
    let items = if extension = "fsproj" then [ itemOf "Compile" file ] else []

    XDocument(
        node
            "Project"
            ([ attribute "Sdk" "Microsoft.NET.Sdk"
               node "PropertyGroup" [ node property [ frameworks :> obj ] ]
               node "ItemGroup" (items @ List.map (itemOf "ProjectReference") references) ]
             @ extra)
    )
        .Save(NativePaths.Resolve(dir, $"{name}.{extension}"))

    let path = NativePaths.Resolve(dir, file)
    File.WriteAllText(path, source)
    path

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

/// Base, Core and App — App reading Core, Core reading Base, all `net48;net10.0` —
/// restored, never built, loaded as one folder.
let private openSolution () =
    task {
        let root = NativePaths.Temp($"sharplsp-fs-cs-{Guid.NewGuid():N}")
        let both = "net48;net10.0"
        let named = writeProject root "Base" "csproj" both "Named.cs" namedSource [] []
        let greeter = writeProject root "Core" "csproj" both "Greeter.cs" (greeterSource "Greet") [ NativePaths.Join("..", "Base", "Base.csproj") ] []
        let app = writeProject root "App" "fsproj" both "App.fs" appSource [ NativePaths.Join("..", "Core", "Core.csproj") ] []
        restore (NativePaths.Resolve(root, "App", "App.fsproj"))
        let state = FSharpWorkspace.create ()
        let! loaded = FSharpWorkspace.loadProject state root
        Assert.True(Result.isOk loaded, $"the project loads: {loaded}")
        return state, root, named, greeter, app
    }

/// The loaded project that compiles `file`.
let private entryOf (state: FSharpWorkspace.FSharpWorkspaceState) (file: string) =
    state.Projects.Values
    |> Seq.find (fun entry -> entry.Options.SourceFiles |> Array.exists (fun source -> NativePaths.AreEqual(source, file)))

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

/// `location` is `file` at `line`, with `identifier` starting at the column.
let private landsOn (file: string) (line: int) (identifier: string) (foundFile: string, foundLine: int, foundColumn: int) =
    Assert.True(NativePaths.AreEqual(file, foundFile), $"`{identifier}` lands in {NativePaths.NameOf file}: {foundFile}")
    Assert.Equal(line, foundLine)
    let text = (File.ReadAllLines file)[line]
    Assert.Equal(identifier, text.Substring(foundColumn, identifier.Length))

/// The reference to Core MSBuild resolved for `entry` under `framework`.
let private resolvedCore (entry: FSharpDesignTime.FSharpProjectEntry) (framework: string) =
    entry.Resolved[framework] |> List.find (fun reference -> NativePaths.NameOf reference.Project = "Core.csproj")

/// The C# assemblies `options` read in memory, by the name each is read under, sorted.
let private assembliesReadBy (options: FSharpProjectOptions) =
    options.ReferencedProjects
    |> Array.map (fun referenced ->
        match referenced with
        | FSharpReferencedProject.PEReference(_, reader) -> reader.OutputFile
        | other -> failwith $"only C# projects are read in memory here: {other}")
    |> Array.sort

[<Fact>]
let ``a project reads the C# project it references in memory, never built, and navigates into its source`` () =
    task {
        let! (state, root, named, greeter, app) = openSolution ()

        try
            Assert.Empty(Directory.GetFiles(root, "*.dll", SearchOption.AllDirectories))
            let entry = entryOf state app
            Assert.Equal(Some "net48", entry.Active)
            let reference = resolvedCore entry "net48"
            Assert.Equal("net48", reference.Framework)
            Assert.Contains($"-r:{reference.Assembly}", entry.Options.OtherOptions)

            // MSBuild passes App Core and, transitively, the Base it reads: each image is read
            // under MSBuild's own -r:, and no second -r: is added.
            let wired = (FSharpWorkspace.optionsFor state app).Value
            Assert.Equal<string array>(entry.Options.OtherOptions, wired.OtherOptions)
            let resolved = entry.Resolved["net48"] |> List.map _.Assembly |> List.sort |> Array.ofList
            Assert.Equal(2, resolved.Length)
            Assert.Contains(reference.Assembly, resolved)
            Assert.Equal<string array>(resolved, assembliesReadBy wired)
            // Core and the Base it reads, both for net48; Roslyn tolerated Broken's body.
            Assert.Equal(2, state.CSharpBuilds.Count)

            let! appErrors = errorsIn state app
            Assert.Empty(appErrors)
            let! greet = definitionOf state app 3 25
            landsOn greeter 4 "Greet" greet
            let! greeterType = definitionOf state app 3 17
            landsOn greeter 2 "Greeter" greeterType
            let! name = definitionOf state app 4 19
            landsOn named 4 "Name" name
            let! onFramework = definitionOf state app 6 29
            landsOn greeter 7 "OnFramework" onFramework
            let! typeOfGreeter = FSharpWorkspace.getTypeDefinition state app 2 4
            landsOn greeter 2 "Greeter" (typeOfGreeter.Value.FilePath, typeOfGreeter.Value.Line, typeOfGreeter.Value.Character)
            let! hover = FSharpWorkspace.getHover state app 3 25
            Assert.Contains("Greet", (hover.Value |> fun (markdown, _, _, _, _) -> markdown))

            // On net10.0, App reads the net10.0 build of Core, where OnModern exists.
            let! switched = FSharpTargetFrameworks.switch state app "net10.0" CancellationToken.None
            Assert.True(Result.isOk switched, $"{switched}")
            Assert.Equal("net10.0", (resolvedCore (entryOf state app) "net10.0").Framework)
            let! modernErrors = errorsIn state app
            Assert.Empty(modernErrors)
            let! onModern = definitionOf state app 8 29
            landsOn greeter 9 "OnModern" onModern
            Assert.Equal(4, state.CSharpBuilds.Count)
        finally
            cleanup root
    }

[<Fact>]
let ``a saved C# edit reaches F# on the next check, without a build`` () =
    task {
        let! (state, root, _, greeter, app) = openSolution ()

        try
            let! before = errorsIn state app
            Assert.Empty(before)

            let save (source: string) =
                File.WriteAllText(greeter, source)
                File.SetLastWriteTimeUtc(greeter, File.GetLastWriteTimeUtc(greeter).AddSeconds 2.0)

            save (greeterSource "Greets")
            let! broken = errorsIn state app
            Assert.Equal<int list>([ 3 ], broken |> List.map fst)
            Assert.All(broken, fun (_, message) -> Assert.Contains("Greet", message))

            save (greeterSource "Greet")
            let! restored = errorsIn state app
            Assert.Empty(restored)
            let! greet = definitionOf state app 3 25
            landsOn greeter 4 "Greet" greet
        finally
            cleanup root
    }

[<Fact>]
let ``a C# project MSBuild cannot compile leaves the reference on its DLL, and the log says why`` () =
    task {
        let root = NativePaths.Temp($"sharplsp-fs-cs-bad-{Guid.NewGuid():N}")

        try
            let failsOnPurpose =
                node
                    "Target"
                    [ attribute "Name" "FailOnPurpose"
                      attribute "BeforeTargets" "CoreCompile"
                      node "Error" [ attribute "Text" "SharpLsp fixture: the C# compile fails on purpose" ] ]

            let bad = "namespace Bad { public static class Thing { public static int Value = 1; } }\n"
            writeProject root "Bad" "csproj" "net10.0" "Thing.cs" bad [] [ failsOnPurpose ] |> ignore
            let app = writeProject root "App" "fsproj" "net10.0" "App.fs" "module App.Main\n\nlet value = Bad.Thing.Value\n" [ NativePaths.Join("..", "Bad", "Bad.csproj") ] []
            restore (NativePaths.Resolve(root, "App", "App.fsproj"))
            let state = FSharpWorkspace.create ()
            let! loaded = FSharpWorkspace.loadProject state root
            Assert.True(Result.isOk loaded, $"the project loads: {loaded}")

            // A single-target project that reads C# is still MSBuild's to evaluate.
            let entry = entryOf state app
            Assert.Empty(entry.Frameworks)
            Assert.Equal(None, entry.Active)
            Assert.Equal(Some "net10.0", FSharpDesignTime.builtFramework entry)
            let reference = entry.Resolved["net10.0"] |> List.exactlyOne
            Assert.EndsWith("Bad.dll", reference.Assembly)
            Assert.Contains($"-r:{reference.Assembly}", entry.Options.OtherOptions)
            Assert.Empty((FSharpWorkspace.optionsFor state app).Value.ReferencedProjects)
            Assert.Empty(state.CSharpBuilds)

            match! FSharpCSharpReferences.prepare state.CSharpBuilds [] reference CancellationToken.None with
            | Ok _ -> failwith "the C# compile fails on purpose"
            | Error reason ->
                Assert.StartsWith("exit ", reason)
                Assert.Contains("the C# compile fails on purpose", reason)

            let! errors = errorsIn state app
            Assert.NotEmpty(errors)
        finally
            cleanup root
    }

/// A build's stamp is when its inputs last changed: project file, sources, and the builds
/// it references — the reason a saved edit anywhere in the graph is read again.
[<Fact>]
let ``a build is stamped by the newest of its project, its sources and the builds it reads`` () =
    let root = NativePaths.Temp($"sharplsp-fs-cs-stamp-{Guid.NewGuid():N}")

    try
        let write (name: string) (at: DateTime) =
            let path = NativePaths.Resolve(root, name)
            Directory.CreateDirectory(NativePaths.DirectoryOf path |> string) |> ignore
            File.WriteAllText(path, "")
            File.SetLastWriteTimeUtc(path, at)
            path

        let day (n: float) = DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays n
        let inner = write "Base/Base.csproj" (day 1.0)
        let innerSource = write "Base/Named.cs" (day 5.0)
        let outer = write "Core/Core.csproj" (day 2.0)
        let outerSource = write "Core/Greeter.cs" (day 3.0)

        let buildOf project (sources: string list) references =
            { FSharpCSharpReferences.Project = project
              FSharpCSharpReferences.Framework = "net10.0"
              FSharpCSharpReferences.Reference = NativePaths.WithExtension(project, ".dll") |> string
              FSharpCSharpReferences.Arguments = CSharpCommandLineParser.Default.Parse(sources, NativePaths.DirectoryOf project |> string, null)
              FSharpCSharpReferences.References = references
              FSharpCSharpReferences.Gate = obj ()
              FSharpCSharpReferences.Emitted = None }

        let baseBuild = buildOf inner [ innerSource ] []
        Assert.Equal(day 5.0, FSharpCSharpReferences.stampOf baseBuild)
        let alone = buildOf outer [ outerSource ] []
        Assert.Equal(day 3.0, FSharpCSharpReferences.stampOf alone)
        let reading = buildOf outer [ outerSource ] [ baseBuild ]
        Assert.Equal(day 5.0, FSharpCSharpReferences.stampOf reading)
        File.SetLastWriteTimeUtc(outer, day 9.0)
        Assert.Equal(day 9.0, FSharpCSharpReferences.stampOf reading)
    finally
        cleanup root
