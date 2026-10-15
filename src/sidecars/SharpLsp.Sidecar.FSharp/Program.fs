module SharpLsp.Sidecar.FSharp.Program

open System
open System.Reflection
open Serilog
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Logging
open SharpLsp.Sidecar.FSharp

/// The semantic-version string of this assembly (3 components).
let internal versionString () : string =
    Assembly.GetExecutingAssembly().GetName().Version
    |> Option.ofObj
    |> Option.map (fun v -> v.ToString(3))
    |> Option.defaultValue "0.0.0"

/// A malformed command line: one FATAL line on stderr, non-zero exit.
let private usageError (error: string) : int =
    eprintfn $"FATAL: {error} (SharpLsp.Sidecar.FSharp)"
    1

/// Serve until shutdown or host exit. A listener that never bound — or
/// supervision that could not be installed — maps to a non-zero exit so the
/// failure is visible to the host, not an opaque clean exit before READY.
/// [DIST-FAILURE-UX] (GitHub #150), [SIDECAR-PROCESS-PARENT] (GitHub #163)
let private runSidecar (options: SidecarStartupOptions) : int =
    try
        let sidecar = new FSharpSidecar()
        task {
            try
                do! sidecar.RunAsync(options)
                return (if sidecar.StartupFailed then 1 else 0)
            finally
                (sidecar :> IAsyncDisposable).DisposeAsync().AsTask().Wait()
        }
        |> fun t -> t.GetAwaiter().GetResult()
    with ex ->
        Log.Error(ex, "F# sidecar terminated unexpectedly")
        1

/// Run the sidecar, returning a process exit code. Pure return codes (no
/// Environment.Exit) keep this unit-testable — the entry point forwards the
/// code to the OS.
let internal run (args: string[]) : int =
    if args.Length > 0 && args[0] = "--version" then
        printfn $"sharplsp-sidecar-fsharp {versionString ()}"
        0
    else
        SidecarStartupOptions.Parse(args).Match((fun options -> runSidecar options), (fun error -> usageError error))

[<EntryPoint>]
let main (args: string[]) = run args
