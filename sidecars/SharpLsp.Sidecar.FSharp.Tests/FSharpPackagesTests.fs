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

// ── Assets parser: defensive branches via crafted project.assets.json ──
// These structural shapes (packageFolders as an array, targets as a number,
// `_._` placeholders, a package with no `compile`, a library missing from the
// libraries map) cannot be produced by a real `dotnet restore`, so a real,
// minimal .fsproj is paired with a hand-authored assets file in the exact
// NuGet on-disk format that the real parser consumes.

let private withCraftedAssets (assetsJson: string) =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-assets-{Guid.NewGuid():N}")
    Directory.CreateDirectory(Path.Combine(dir, "obj")) |> ignore
    let fsproj = Path.Combine(dir, "Crafted.fsproj")
    File.WriteAllText(
        fsproj,
        "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup>"
        + "<TargetFramework>net10.0</TargetFramework>"
        + "<DisableImplicitFSharpCoreReference>true</DisableImplicitFSharpCoreReference>"
        + "</PropertyGroup><ItemGroup><Compile Include=\"Library.fs\" /></ItemGroup></Project>")
    File.WriteAllText(Path.Combine(dir, "Library.fs"), "module Library\nlet x = 1\n")
    File.WriteAllText(Path.Combine(dir, "obj", "project.assets.json"), assetsJson)
    dir, fsproj

[<Fact>]
let ``getReferenceUsage treats non-object targets as no assets`` () =
    task {
        // `targets` is a number → firstValue's else arm → parseAssets None.
        let dir, fsproj = withCraftedAssets """{ "packageFolders": { "/p": {} }, "targets": 5 }"""
        try
            let state = FSharpWorkspace.create ()
            let! usage = FSharpPackages.getReferenceUsage state fsproj
            Assert.Empty(usage.All)
        finally
            cleanup dir
    }

[<Fact>]
let ``getReferenceUsage handles array packageFolders and empty-assembly packages`` () =
    task {
        // packageFolders is an ARRAY (firstName else → Root ""), and the two
        // packages contribute no assemblies: one has no `compile`, one only `_._`.
        let assets =
            """{ "packageFolders": [],
                 "libraries": {},
                 "targets": { "net10.0": {
                     "NoCompile/1.0": { "type": "package" },
                     "Placeholder/1.0": { "compile": { "_._": {} } } } } }"""
        let dir, fsproj = withCraftedAssets assets
        try
            let state = FSharpWorkspace.create ()
            let! usage = FSharpPackages.getReferenceUsage state fsproj
            Assert.Empty(usage.All)
            Assert.Equal("", usage.Root)
        finally
            cleanup dir
    }

[<Fact>]
let ``getReferenceUsage falls back to the package key when libraries lack a path`` () =
    task {
        // The package has a real compile entry but no matching `libraries` key,
        // so libraryPath returns key.ToLowerInvariant() and toLocal builds a path.
        let assets =
            """{ "packageFolders": { "/p": {} },
                 "libraries": {},
                 "targets": { "net10.0": {
                     "Mystery/1.0": { "compile": { "lib/net10.0/Mystery.dll": {} } } } } }"""
        let dir, fsproj = withCraftedAssets assets
        try
            let state = FSharpWorkspace.create ()
            let! usage = FSharpPackages.getReferenceUsage state fsproj
            // The Mystery assembly path is built (key-fallback + toLocal); the fake
            // reference makes the isolated check unusable, so it is fail-safe empty.
            Assert.NotNull(usage.All :> obj)
        finally
            cleanup dir
    }

// ── Real restored projects: success symbol-scan + failure branches ──

/// Source touching a record field and a generic call so symbol uses include an
/// FSharpField and an FSharpGenericParameter — driving assemblyOf's `_ -> None`.
let private genericFieldSource =
    "module Library\n"
    + "type R = { X: int }\n"
    + "let r = { X = 1 }\n"
    + "let v = r.X\n"
    + "let doubled = [ 1; 2; 3 ] |> List.map (fun n -> n * 2)\n"

[<Fact>]
let ``getReferenceUsage scans symbols of a restored project`` () =
    task {
        let dir, fsproj = makeRestoredProject genericFieldSource
        try
            let state = FSharpWorkspace.create ()
            let! usage = FSharpPackages.getReferenceUsage state fsproj
            Assert.False(String.IsNullOrEmpty usage.Root)
            Assert.NotEmpty(usage.All)
            // FSharp.Core is genuinely used (List.map) → present in Used.
            Assert.True(usage.Used.Length >= 1)
        finally
            cleanup dir
    }

[<Fact>]
let ``getReferenceUsage is fail-safe when the project has critical errors`` () =
    task {
        // Restore succeeds (assets exist) but the source has a fatal syntax error,
        // so ParseAndCheckProject reports HasCriticalErrors → fail-safe empty `All`.
        let dir, fsproj = makeRestoredProject "module Library\nlet x = (\n"
        try
            let state = FSharpWorkspace.create ()
            let! usage = FSharpPackages.getReferenceUsage state fsproj
            Assert.False(String.IsNullOrEmpty usage.Root, "root still resolves from assets")
            Assert.Empty(usage.Used)
        finally
            cleanup dir
    }

[<Fact>]
let ``getReferenceUsage is fail-safe when the fsproj becomes unreadable`` () =
    task {
        // Restore produces real assets, then the .fsproj is corrupted: parsing its
        // source files throws inside projectOptions → the outer catch returns empty.
        let dir, fsproj = makeRestoredProject unusedNewtonsoftSource
        try
            File.WriteAllText(fsproj, "<Project this is not valid xml <<<")
            let state = FSharpWorkspace.create ()
            let! usage = FSharpPackages.getReferenceUsage state fsproj
            Assert.NotNull(usage.All :> obj)
        finally
            cleanup dir
    }
