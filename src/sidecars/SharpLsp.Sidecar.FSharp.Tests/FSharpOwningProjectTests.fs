/// A file no loaded project compiles answers from the project that owns it: the editor
/// opening the file is enough, and the workspace's own projects stay loaded (GitHub #414).
/// Implements [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING].
module SharpLsp.Sidecar.FSharp.Tests.FSharpOwningProjectTests

open System
open System.Diagnostics
open System.IO
open System.Threading.Tasks
open MessagePack
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.SidecarEndToEndTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpResolvedReferenceTests

/// `perimeter` at (3, 4) carries a doc comment; `fence` at (5, 4) is a float.
let private loneSource =
    String.Join(
        "\n",
        [ "module Lone.Shapes"
          ""
          "/// The perimeter of a square."
          "let perimeter (side: float) = 4.0 * side"
          ""
          "let fence = perimeter 2.5"
          "" ]
    )

/// A real project, outside the workspace the sidecar opened, compiling `Shapes.fs`
/// with `properties` in its property group.
let private writeProject (properties: string) =
    let dir = NativePaths.Temp($"sharplsp-owning-{Guid.NewGuid():N}", "Lone")
    Directory.CreateDirectory dir |> ignore

    File.WriteAllText(
        NativePaths.Resolve(dir, "Lone.fsproj"),
        $"""<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
{properties}
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Shapes.fs" />
  </ItemGroup>
</Project>"""
    )

    let source = NativePaths.Resolve(dir, "Shapes.fs")
    File.WriteAllText(source, loneSource)
    dir, source

let private writeLoneProject () =
    writeProject
        """    <TargetFramework>net10.0</TargetFramework>
    <DisableImplicitFSharpCoreReference>true</DisableImplicitFSharpCoreReference>"""

/// The hover at (`line`, `character`), polled until it answers or a minute passes:
/// the owning project loads in the background, after the editor opens the file.
let private hoverWithin (fixture: SidecarFixture) file line character =
    task {
        let clock = Stopwatch.StartNew()
        let mutable answer: HoverResult option = None

        while answer.IsNone && clock.Elapsed < TimeSpan.FromSeconds 60.0 do
            let! response = fixture.Send("textDocument/hover", posPayload file line character)
            Assert.Null(response.Error)

            if response.Payload <> [| 0xC0uy |] then
                answer <- Some(deserialize<HoverResult> response.Payload)
            else
                do! Task.Delay 250

        return answer
    }

let private opened (fixture: SidecarFixture) file =
    task {
        let text = File.ReadAllText file
        let payload = MessagePackSerializer.Serialize({ DidChangeRequest.FilePath = file; NewText = text })
        let! response = fixture.Send("textDocument/didChange", payload)
        Assert.Null(response.Error)
    }

[<Fact>]
let ``a file outside the loaded workspace answers hover from the project that owns it`` () =
    task {
        let fixture = new SidecarFixture()
        let lifetime = fixture :> IAsyncLifetime
        let loneDir, shapes = writeLoneProject ()

        try
            do! lifetime.InitializeAsync()
            do! opened fixture shapes

            let! perimeter = hoverWithin fixture shapes 3 4
            Assert.True(perimeter.IsSome, $"hover answers in {shapes}, which only Lone.fsproj compiles")
            Assert.Contains("perimeter", perimeter.Value.Contents)
            Assert.Contains("The perimeter of a square.", perimeter.Value.Contents)

            let! fence = hoverWithin fixture shapes 5 4
            Assert.True(fence.IsSome, "a second symbol answers from the same project")
            Assert.Contains("float", fence.Value.Contents)

            // The workspace the sidecar opened still answers: its project was never replaced.
            let! add = hoverWithin fixture fixture.Src 6 4
            Assert.True(add.IsSome, "the workspace's own file still answers")
            Assert.Contains("Adds two numbers", add.Value.Contents)
        finally
            lifetime.DisposeAsync().GetAwaiter().GetResult()
            try Directory.Delete(NativePaths.DirectoryOf loneDir, true) with _ -> ()
    }

/// fstoolkit's shape: several target frameworks, a netstandard one first, FSharp.Core
/// and the netstandard reference pack from NuGet — restored into a packages folder of
/// the project's own and resolved once, as any build leaves it, then emptied, as
/// clearing the NuGet cache leaves a built project. The assets file and the build's
/// assets cache still name every package; none is on disk, and MSBuild, trusting
/// the cache, reports compiler arguments that reference none of them.
let private writeEmptiedProject () =
    let dir, source =
        writeProject
            """    <TargetFrameworks>netstandard2.1;net10.0</TargetFrameworks>
    <RestorePackagesPath>$(MSBuildProjectDirectory)/packages</RestorePackagesPath>"""

    let project = NativePaths.Resolve(dir, "Lone.fsproj")
    restore project
    FSharpDesignTimeTests.dotnet dir "msbuild Lone.fsproj -nologo -t:ResolvePackageAssets -p:TargetFramework=netstandard2.1"
    Directory.Delete(NativePaths.Resolve(dir, "packages"), true)
    dir, source

/// [DIAG-RESTORE]: a project whose restored packages have left the disk is restored
/// again before it loads, so the file still checks against FSharp.Core and netstandard.
[<Fact>]
let ``a file whose project lost its restored packages answers hover once they are restored`` () =
    task {
        let fixture = new SidecarFixture()
        let lifetime = fixture :> IAsyncLifetime
        let loneDir, shapes = writeEmptiedProject ()

        try
            do! lifetime.InitializeAsync()
            do! opened fixture shapes

            let! perimeter = hoverWithin fixture shapes 3 4
            Assert.True(perimeter.IsSome, $"hover answers in {shapes} once its packages are back")
            Assert.Contains("float -> float", perimeter.Value.Contents)
            Assert.Contains("The perimeter of a square.", perimeter.Value.Contents)
            Assert.True(Directory.Exists(NativePaths.Resolve(loneDir, "packages", "fsharp.core")), "FSharp.Core was restored")
        finally
            lifetime.DisposeAsync().GetAwaiter().GetResult()
            try Directory.Delete(NativePaths.DirectoryOf loneDir, true) with _ -> ()
    }
