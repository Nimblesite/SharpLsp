/// F# script (.fsx) support — ALL real, NO mocks.
/// Covers [SCRIPT-FSX-OPTIONS], [SCRIPT-FSX-SYMBOLS], [SCRIPT-DETECT], [SCRIPT-CLOSURE].
module SharpLsp.Sidecar.FSharp.Tests.FSharpScriptTests

open System
open System.IO
open Xunit
open SharpLsp.Sidecar.FSharp

let private tempDir () =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-fsx-{Guid.NewGuid():N}")
    Directory.CreateDirectory(dir) |> ignore
    dir

let private write (dir: string) (name: string) (text: string) =
    let path = Path.Combine(dir, name)
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

        let! result = FSharpWorkspace.loadProject ws script

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

        let! _ = FSharpWorkspace.loadProject ws script

        let sourceFiles =
            ws.ProjectOptions
            |> Option.map (fun o -> o.SourceFiles)
            |> Option.defaultValue [||]

        let containsScript (name: string) =
            sourceFiles
            |> Array.exists (fun f -> f.EndsWith(name, StringComparison.OrdinalIgnoreCase))

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

        let! _ = FSharpWorkspace.loadProject ws script

        let otherOptions =
            ws.ProjectOptions
            |> Option.map (fun o -> o.OtherOptions)
            |> Option.defaultValue [||]

        Assert.Contains("--define:INTERACTIVE", otherOptions)
        Assert.Contains("--define:EDITING", otherOptions)
        Assert.DoesNotContain("--define:COMPILED", otherOptions)
        Directory.Delete(dir, true)
    }
