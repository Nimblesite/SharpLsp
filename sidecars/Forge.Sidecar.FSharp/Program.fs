open System
open Forge.Sidecar.FSharp

[<EntryPoint>]
let main (args: string[]) =
    if args.Length < 1 then
        eprintfn "Usage: Forge.Sidecar.FSharp <socket-path>"
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
        eprintfn $"F# sidecar failed: {ex.Message}"
        Environment.Exit(1)

    0
