// FsOrderLedger rejections: every refused order keeps its F# exception object, including the
// stack trace it captured, in a module-level ResizeArray that only `release` clears.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsOrderLedger.Rejections

open FsOrderLedger

let rejected = ResizeArray<exn> ()

/// Records one rejection: the exception carries the order id and a human-readable reason.
let reject (orderId: int) : unit =
    let failure = OrderRejected(orderId, sprintf "order %d declined by risk check" orderId)
    rejected.Add failure
