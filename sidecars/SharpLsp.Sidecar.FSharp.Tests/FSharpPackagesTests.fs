/// [PKG-UNUSED-DETECT-FS] Tests for FSharpPackages.getReferenceUsage.
///
/// A real, restored .fsproj is checked through FCS so a referenced-but-unused
/// package assembly is correctly classified (present in `All`, absent from
/// `Used`). The fail-safe paths (missing assets, non-existent project) are
/// covered too, since the module promises an empty result on any uncertainty.
module SharpLsp.Sidecar.FSharp.Tests.FSharpPackagesTests

open System
open System.Diagnostics
open System.IO
open Xunit
open SharpLsp.Sidecar.FSharp

/// Quietly delete a temp directory.
let private cleanup (dir: string) =
    try
        Directory.Delete(dir, true)
    with _ ->
        ()

/// Does any path mention the given (lowercased) needle?
let private mentions (paths: string array) (needle: string) =
    paths |> Array.exists (fun p -> p.ToLowerInvariant().Contains(needle))

/// Write a real .fsproj referencing `Newtonsoft.Json` plus one source file,
/// then `dotnet restore` it so obj/project.assets.json and the package compile
/// assemblies exist on disk for the isolated usage check. Returns (dir, fsproj).
let private makeRestoredProject (source: string) =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-pkg-{Guid.NewGuid():N}")
    Directory.CreateDirectory(dir) |> ignore

    let fsproj =
        """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Library.fs" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>"""

    let fsprojPath = Path.Combine(dir, "PkgProject.fsproj")
    File.WriteAllText(fsprojPath, fsproj)
    File.WriteAllText(Path.Combine(dir, "Library.fs"), source)

    let psi = ProcessStartInfo("dotnet", "restore --verbosity quiet")
    psi.WorkingDirectory <- dir
    psi.RedirectStandardOutput <- true
    psi.RedirectStandardError <- true
    use proc = new Process()
    proc.StartInfo <- psi
    proc.Start() |> ignore
    proc.WaitForExit()
    Assert.True((proc.ExitCode = 0), "dotnet restore must succeed")
    (dir, fsprojPath)

/// Source that exercises FSharp.Core (List) but never touches Newtonsoft.Json,
/// so Newtonsoft is genuinely referenced-but-unused.
let private unusedNewtonsoftSource =
    "module Library\n"
    + "let doubled = [ 1; 2; 3 ] |> List.map (fun x -> x * 2)\n"
    + "let total = List.sum doubled\n"

[<Fact>]
let ``getReferenceUsage flags a referenced-but-unused package`` () =
    task {
        let (dir, fsproj) = makeRestoredProject unusedNewtonsoftSource

        try
            let state = FSharpWorkspace.create ()
            let! usage = FSharpPackages.getReferenceUsage state fsproj

            Assert.False(String.IsNullOrEmpty usage.Root, "packages root resolved from assets")
            Assert.NotEmpty(usage.All)
            Assert.True(
                mentions usage.All "newtonsoft.json",
                "Newtonsoft assembly is among the All referenced assemblies"
            )
            Assert.False(
                mentions usage.Used "newtonsoft.json",
                "Newtonsoft is never used → it must be absent from Used"
            )
            // Used is necessarily a subset of All.
            Assert.True(usage.Used.Length <= usage.All.Length)
        finally
            cleanup dir
    }

[<Fact>]
let ``getReferenceUsage is fail-safe when assets are missing`` () =
    task {
        // A real .fsproj that was never restored → no obj/project.assets.json.
        let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-pkg-{Guid.NewGuid():N}")
        Directory.CreateDirectory(dir) |> ignore
        let fsproj = Path.Combine(dir, "Bare.fsproj")
        File.WriteAllText(fsproj, "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>")

        try
            let state = FSharpWorkspace.create ()
            let! usage = FSharpPackages.getReferenceUsage state fsproj
            Assert.Empty(usage.All)
            Assert.Empty(usage.Used)
        finally
            cleanup dir
    }

[<Fact>]
let ``getReferenceUsage is fail-safe for a non-existent project`` () =
    task {
        let state = FSharpWorkspace.create ()
        let! usage = FSharpPackages.getReferenceUsage state "/no/such/Ghost.fsproj"
        Assert.Empty(usage.All)
        Assert.Empty(usage.Used)
        Assert.Equal("", usage.Root)
    }
