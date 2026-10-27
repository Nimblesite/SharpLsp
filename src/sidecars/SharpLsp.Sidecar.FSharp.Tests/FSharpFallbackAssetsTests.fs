/// Real SDK roots and assemblies, including a cache populated after restore.
/// Implements [PKG-ASSETS-FS] and [DIAG-TRUTH-GUARANTEES] (GitHub #481).
module SharpLsp.Sidecar.FSharp.Tests.FSharpFallbackAssetsTests

open System
open System.IO
open System.Text.Json
open System.Xml.Linq
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests

let private assemblySegments = [| "newtonsoft.json"; "13.0.3"; "lib"; "net6.0"; "Newtonsoft.Json.dll" |]

let private assemblyIn root = NativePaths.Resolve(root, assemblySegments)

let private writeProject directory (properties: (string * string) list) =
    Directory.CreateDirectory(directory) |> ignore
    let document = XDocument.Parse("""<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
      <ItemGroup><Compile Include="Library.fs" />
        <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
      </ItemGroup></Project>""")
    let group = Assert.Single(document.Descendants(XName.Get "PropertyGroup"))
    properties |> List.iter (fun (name, value) -> group.Add(XElement(XName.Get name, value)))
    let project = NativePaths.Resolve(directory, "Fallback.fsproj")
    document.Save(project)
    File.WriteAllText(NativePaths.Resolve(directory, "Library.fs"),
                      "module Library\nlet text: string = Newtonsoft.Json.JsonConvert.SerializeObject(42)\n")
    project

/// Observe the SDK's own metadata, independently of the production assets parser.
let private sdkFolders project =
    let assets = NativePaths.Resolve(NativePaths.DirectoryOf project, "obj", "project.assets.json")
    use document = JsonDocument.Parse(File.ReadAllText assets)
    document.RootElement.GetProperty("packageFolders").EnumerateObject()
    |> Seq.map _.Name |> Seq.toArray

let private restore directory project =
    FSharpDesignTimeTests.dotnet directory $"restore \"{project}\" --nologo --disable-build-servers -v q"

let private prepare root =
    Directory.CreateDirectory(root) |> ignore
    for name in [ "Directory.Build.props"; "Directory.Build.targets" ] do
        File.WriteAllText(NativePaths.Resolve(root, name), "<Project />")
    let seedDirectory = NativePaths.Resolve(root, "Seed")
    let seed = writeProject seedDirectory []
    restore seedDirectory seed
    let folders = sdkFolders seed
    let directory = NativePaths.Resolve(root, "Consumer")
    let primary = NativePaths.Resolve(root, "empty-primary")
    let project = writeProject directory [ ("RestorePackagesPath", primary);
                                          ("RestoreAdditionalProjectFallbackFolders", String.Join(";", folders)) ]
    restore directory project
    FSharpDesignTimeTests.dotnet directory $"build \"{project}\" --no-restore --nologo --disable-build-servers -v q"
    let fallback = sdkFolders project |> Array.find (assemblyIn >> File.Exists)
    project, primary, assemblyIn fallback

let private assertResolution project primary expected =
    let parsed = FSharpAssets.parseAssets project
    Assert.True(parsed.IsSome, "SDK assets must remain readable")
    let root, assemblies = parsed.Value
    Assert.True(NativePaths.AreEqual(primary, root), "metadata retains the primary cache")
    let reference = Assert.Single(assemblies |> List.filter (fun assembly -> assembly.Simple = "Newtonsoft.Json"))
    Assert.True(NativePaths.AreEqual(expected, reference.Path), "select the first physical compile assembly")
    Assert.True(File.Exists(reference.Path))
    Assert.Contains($"-r:{reference.Path}", FSharpAssets.packageReferenceArgs assemblies)
    Assert.All(assemblies, fun assembly -> Assert.True(File.Exists(assembly.Path), "no phantom missing reference"))

let private assertUsedFallback project primary fallback = task {
    assertResolution project primary fallback
    let state = FSharpWorkspace.create ()
    let! usage = FSharpPackages.getReferenceUsage state project
    Assert.True(NativePaths.AreEqual(primary, usage.Root))
    Assert.Contains(fallback, usage.All)
    Assert.Contains(fallback, usage.Used)
}

[<Fact>]
let ``SDK fallback references survive a primary cache appearing and disappearing without another restore`` () = task {
    let root = NativePaths.Temp($"sharplsp-fallback-{Guid.NewGuid():N}")
    try
        let project, primary, fallback = prepare root
        let folders = sdkFolders project
        Assert.True(folders.Length >= 2)
        Assert.True(NativePaths.AreEqual(primary, folders[0]))
        let primaryAssembly = assemblyIn primary
        Assert.False(File.Exists(primaryAssembly))
        do! assertUsedFallback project primary fallback
        // A genuine restored assembly entering the earlier cache takes precedence.
        Directory.CreateDirectory(NativePaths.DirectoryOf primaryAssembly) |> ignore
        File.Copy(fallback, primaryAssembly)
        assertResolution project primary primaryAssembly
        File.Delete(primaryAssembly)
        assertResolution project primary fallback
        Assert.Equal<string array>(folders, sdkFolders project)
    finally
        cleanup root
}
