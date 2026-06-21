module SharpLsp.Sidecar.FSharp.Program

open System
open System.Reflection
open Serilog
open SharpLsp.Sidecar.Common.Logging
open SharpLsp.Sidecar.FSharp

/// The semantic-version string of this assembly (3 components).
let internal versionString () : string =
    Assembly.GetExecutingAssembly().GetName().Version
    |> Option.ofObj
    |> Option.map (fun v -> v.ToString(3))
    |> Option.defaultValue "0.0.0"

/// Run the sidecar, returning a process exit code. Pure return codes (no
/// Environment.Exit) keep this unit-testable — the entry point forwards the
/// code to the OS.
let internal run (args: string[]) : int =
    if args.Length > 0 && args[0] = "--version" then
        printfn $"sharplsp-sidecar-fsharp {versionString ()}"
        0
    elif args.Length < 1 then
        eprintfn "Usage: SharpLsp.Sidecar.FSharp <socket-path>"
        1
    else
        try
            let socketPath = args[0]
            let sidecar = new FSharpSidecar()
            task {
                try
                    do! sidecar.RunAsync(socketPath)
                finally
                    (sidecar :> IAsyncDisposable).DisposeAsync().AsTask().Wait()
            }
            |> fun t -> t.GetAwaiter().GetResult()
            0
        with ex ->
            Log.Error(ex, "F# sidecar terminated unexpectedly")
            1

[<EntryPoint>]
let main (args: string[]) = run args
