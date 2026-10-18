// FsStorefront: the F# demo workload the website's profiler film records.
// It checks out orders forever, with real hot paths and a cache that never evicts.
module FsStorefront.Program

open System

[<EntryPoint>]
let main _ =
    let catalog = Catalog.generate 2_000
    printfn $"FsStorefront running (PID {Environment.ProcessId})"
    Seq.initInfinite (Checkout.checkout catalog) |> Seq.iter Sessions.remember
    0
