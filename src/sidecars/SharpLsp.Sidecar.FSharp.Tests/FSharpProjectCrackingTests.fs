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
open System.Xml.Linq
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests

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
    let fsproj = Path.Combine(dir, $"{projectName}.fsproj")
    XDocument(project).Save(fsproj)
    File.WriteAllText(Path.Combine(dir, "Library.fs"), "module Cracked.Library\n\nlet answer = 42\n")
    fsproj

/// A referenced C# project whose output assembly is already built. The copied
/// file is a genuine managed assembly, so `-r:` names something FCS can open.
let private writeBuiltCsharpReference (root: string) =
    let projectDir = Path.Combine(root, "Neighbour")
    let outputDir = Path.Combine(projectDir, "bin", "Debug", "net10.0")
    Directory.CreateDirectory(outputDir) |> ignore
    let csproj = Path.Combine(projectDir, "Neighbour.csproj")

    XDocument(node "Project" [| attr "Sdk" "Microsoft.NET.Sdk" |]).Save(csproj)

    let assembly = Path.Combine(outputDir, "Neighbour.dll")
    File.Copy(typeof<SharpLsp.Sidecar.Common.NativePaths>.Assembly.Location, assembly, true)
    assembly

/// Unexpanded MSBuild properties must be dropped, real flags must survive.
let private FLAGS_WITHOUT_OUTPUT = "--nowarn:52 $(UnexpandedExtraFlags) --warnon:1182"

[<Fact>]
let ``cracking a real fsproj carries OtherFlags to FCS and drops unexpanded properties`` () =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-crack-{Guid.NewGuid():N}")

    try
        let fsproj = writeProject dir "CrackedA" FLAGS_WITHOUT_OUTPUT [||]
        let flags = FSharpWorkspace.parseFsprojOtherFlags fsproj

        Assert.Equal<string array>([| "--nowarn:52"; "--warnon:1182" |], flags)
        Assert.DoesNotContain(flags, fun flag -> flag.StartsWith("$(", StringComparison.Ordinal))
    finally
        cleanup dir

[<Fact>]
let ``an AssemblyName MSBuild never expanded falls back to the project file stem`` () =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-crack-{Guid.NewGuid():N}")

    try
        let fsproj = writeProject dir "CrackedA" FLAGS_WITHOUT_OUTPUT [||]

        // "$(MSBuildProjectName)" is not a usable assembly name; the stem is.
        Assert.Equal("CrackedA", FSharpWorkspace.parseFsprojAssemblyName fsproj)
    finally
        cleanup dir

[<Fact>]
let ``compile items become the FCS source list in declaration order`` () =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-crack-{Guid.NewGuid():N}")

    try
        let fsproj = writeProject dir "CrackedA" FLAGS_WITHOUT_OUTPUT [||]
        let sources = FSharpWorkspace.parseFsprojSourceFiles fsproj

        Assert.Equal(1, sources.Length)
        Assert.Equal(Path.Combine(dir, "Library.fs"), sources[0])
        // Source paths must be absolute — FCS resolves nothing relative to cwd.
        Assert.True(Path.IsPathRooted(sources[0]))
    finally
        cleanup dir

[<Fact>]
let ``framework reference args pin the runtime instead of the desktop profile`` () =
    let args = FSharpWorkspace.frameworkReferenceArgs ()

    Assert.Contains("--noframework", args)
    Assert.Contains("--targetprofile:netcore", args)
    // Without FSharp.Core on the line, every fixture would fail to typecheck.
    Assert.Contains(args, fun arg -> arg.EndsWith("FSharp.Core.dll", StringComparison.OrdinalIgnoreCase))

[<Fact>]
let ``a referenced C# project arrives on the compiler line as its built assembly`` () =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-crack-{Guid.NewGuid():N}")

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
        let options = FSharpWorkspace.buildProjectOptions state fsproj

        // [DEFINITION-CROSSLANG]: the C# project is invisible to FCS except as
        // this metadata reference.
        Assert.Contains($"-r:{neighbour}", options.OtherOptions)
        // The project's own OtherFlags survive alongside the reference.
        Assert.Contains("--nowarn:52", options.OtherOptions)
        // No <OtherFlags> output flag, so the cracker stamps the identity itself.
        Assert.Contains("--out:CrackedA.dll", options.OtherOptions)
        Assert.Equal<string array>([| Path.Combine(dir, "Library.fs") |], options.SourceFiles)
    finally
        cleanup dir

[<Fact>]
let ``a project that declares its own output flag is not given a second one`` () =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-crack-{Guid.NewGuid():N}")

    try
        let fsproj = writeProject dir "CrackedB" "--nowarn:52 --out:Custom.dll" [||]
        let state = FSharpWorkspace.create ()
        let options = FSharpWorkspace.buildProjectOptions state fsproj

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

[<Fact>]
let ``a lowercase short output flag also suppresses the generated identity`` () =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-crack-{Guid.NewGuid():N}")

    try
        let fsproj = writeProject dir "CrackedC" "-o:Short.dll" [||]
        let state = FSharpWorkspace.create ()
        let options = FSharpWorkspace.buildProjectOptions state fsproj

        Assert.Contains("-o:Short.dll", options.OtherOptions)
        Assert.DoesNotContain("--out:CrackedC.dll", options.OtherOptions)
    finally
        cleanup dir
