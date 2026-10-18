// FsOrderLedger event bus: a module-level F# `Event` whose handlers capture the subscribing
// request id and are NEVER removed - the classic event-handler leak this fixture profiles.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsOrderLedger.Bus

open System.Threading
open FsOrderLedger

let published = Event<Order> ()

let mutable private subscriptions = 0

/// Subscribes a handler that captures `requestId` and never unsubscribes it.
let subscribe (requestId: int) : unit =
    published.Publish.Add(fun order -> ignore (order.Id + requestId))
    Interlocked.Increment(&subscriptions) |> ignore

let handlers () : int = Volatile.Read(&subscriptions)

let publish (order: Order) : unit = published.Trigger order
