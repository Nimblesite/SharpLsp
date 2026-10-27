/// F# script (.fsx) support — ALL real, NO mocks.
/// Covers [SCRIPT-FSX-OPTIONS], [SCRIPT-FSX-SYMBOLS], [SCRIPT-DETECT], [SCRIPT-CLOSURE].
module SharpLsp.Sidecar.FSharp.Tests.FSharpScriptTests

open System
open System.IO
open System.Threading
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.Common

let private tempDir () =
    let dir = NativePaths.Temp($"sharplsp-fsx-{Guid.NewGuid():N}")
    Directory.CreateDirectory(dir) |> ignore
    dir

let private write (dir: string) (name: string) (text: string) =
    let path = NativePaths.Resolve(dir, name)
    File.WriteAllText(path, text)
    path

/// A standalone .fsx must load through GetProjectOptionsFromScript. Before this,
/// loadProject hard-failed with "No .fsproj found". Implements [SCRIPT-FSX-OPTIONS].
[<Fact>]
let ``standalone fsx loads without an fsproj`` () =
    task {
        let dir = tempDir ()
        let script = write dir "Script.fsx" "let square x = x * x\nprintfn \"%d\" (square 12)\n"
        let ws = FSharpWorkspace.create ()

        let! result = FSharpWorkspaceLoading.loadProject ws script

        Assert.True(
            (match result with
             | Ok () -> true
             | Error _ -> false),
            $"expected the script to load, got {result}")

        Assert.True(ws.IsLoaded)
        Assert.True(ws.ProjectOptions.IsSome)
        Directory.Delete(dir, true)
    }

/// FCS computes the `#load` closure itself; the loaded file must appear in
/// SourceFiles. Implements [SCRIPT-CLOSURE].
[<Fact>]
let ``fsx load closure includes the loaded script`` () =
    task {
        let dir = tempDir ()
        write dir "Lib.fsx" "let double x = x * 2\n" |> ignore
        let script = write dir "Main.fsx" "#load \"Lib.fsx\"\nprintfn \"%d\" (Lib.double 21)\n"
        let ws = FSharpWorkspace.create ()

        let! _ = FSharpWorkspaceLoading.loadProject ws script

        let sourceFiles =
            ws.ProjectOptions
            |> Option.map (fun o -> o.SourceFiles)
            |> Option.defaultValue [||]

        let containsScript (name: string) =
            sourceFiles
            |> Array.exists (fun f -> NativePaths.SameName(f, name))

        Assert.True(containsScript "Lib.fsx", $"Lib.fsx missing from %A{sourceFiles}")
        Assert.True(containsScript "Main.fsx", $"Main.fsx missing from %A{sourceFiles}")
        Directory.Delete(dir, true)
    }

/// A script open in an editor defines INTERACTIVE and EDITING but not COMPILED,
/// so `#if INTERACTIVE` code is live rather than greyed out. Implements [SCRIPT-FSX-SYMBOLS].
[<Fact>]
let ``fsx defines INTERACTIVE and EDITING but not COMPILED`` () =
    task {
        let dir = tempDir ()
        let script = write dir "Defines.fsx" "let x = 1\n"
        let ws = FSharpWorkspace.create ()

        let! _ = FSharpWorkspaceLoading.loadProject ws script

        let otherOptions =
            ws.ProjectOptions
            |> Option.map (fun o -> o.OtherOptions)
            |> Option.defaultValue [||]

        Assert.Contains("--define:INTERACTIVE", otherOptions)
        Assert.Contains("--define:EDITING", otherOptions)
        Assert.DoesNotContain("--define:COMPILED", otherOptions)
        Directory.Delete(dir, true)
    }

/// The markdown a hover at `line`, `character` of `file` shows; empty when none.
let private hoverText ws file line character =
    task {
        let! hover = FSharpWorkspace.getHover ws file line character
        return hover |> Option.map (fun (markdown, _, _, _, _) -> markdown) |> Option.defaultValue ""
    }

/// A folder holding only a script is a valid workspace, and the script answers from
/// its own context: an `.fsx` is never project-owned. Implements [SCRIPT-DEGRADE],
/// [SCRIPT-DETECT] and [SCRIPT-FSX-OPTIONS] (GitHub #497).
[<Fact>]
let ``a script in a folder with no project answers hover and completion`` () =
    task {
        let dir = tempDir ()
        let script = write dir "build.fsx" "let square x = x * x\nlet nine = square 3\n"
        let ws = FSharpWorkspace.create ()

        let! opened = FSharpWorkspaceLoading.loadWorkspaceWithCancellation ws dir false CancellationToken.None
        Assert.True(Result.isOk opened, $"a folder with no project is a valid workspace, got {opened}")

        let! hover = hoverText ws script 1 13
        Assert.Contains("square", hover)
        Assert.Contains("int -> int", hover)
        let! completions = FSharpCompletion.getCompletions ws script 1 13
        Assert.Contains("square", completions |> List.map _.Label)
        Directory.Delete(dir, true)
    }

/// A project in the folder compiles only its own files: a script beside it that it
/// does not list answers from the script's own context, never the project's
/// (GitHub #497).
[<Fact>]
let ``a script beside a project that does not compile it answers from its own context`` () =
    task {
        let dir = tempDir ()
        let project = "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Include=\"Library.fs\" /></ItemGroup></Project>"
        write dir "App.fsproj" project |> ignore
        let library = write dir "Library.fs" "module Library\nlet answer = 42\n"
        let script = write dir "publish.fsx" "let triple x = x * 3\nlet nine = triple 3\n"
        let ws = FSharpWorkspace.create ()

        let! opened = FSharpWorkspaceLoading.loadWorkspaceWithCancellation ws dir true CancellationToken.None
        Assert.True(Result.isOk opened, $"the project loads, got {opened}")
        Assert.True(ws.IsLoaded, "the project is the workspace")

        let! scriptHover = hoverText ws script 1 13
        Assert.Contains("triple", scriptHover)
        Assert.Contains("int -> int", scriptHover)
        let! libraryHover = hoverText ws library 1 5
        Assert.Contains("answer", libraryHover)
        Directory.Delete(dir, true)
    }
