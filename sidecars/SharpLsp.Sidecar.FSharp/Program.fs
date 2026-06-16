open System
open System.Reflection
open Serilog
open SharpLsp.Sidecar.Common.Logging
open SharpLsp.Sidecar.FSharp

[<EntryPoint>]
let main (args: string[]) =
    if args.Length > 0 && args[0] = "--version" then
        let version =
            Assembly.GetExecutingAssembly().GetName().Version
            |> Option.ofObj
            |> Option.map (fun v -> v.ToString(3))
            |> Option.defaultValue "0.0.0"
        printfn $"sharplsp-sidecar-fsharp {version}"
        0
    else

    if args.Length < 1 then
        eprintfn "Usage: SharpLsp.Sidecar.FSharp <socket-path>"
        Environment.Exit(1)

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
    with ex ->
        Log.Error(ex, "F# sidecar terminated unexpectedly")
        Environment.Exit(1)

    0
