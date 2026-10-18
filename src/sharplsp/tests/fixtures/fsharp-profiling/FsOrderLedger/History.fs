// FsOrderLedger undo history: every snapshot keeps the whole immutable `Map` of orders and is
// never dropped, so history grows without bound while re-using the same Order instances.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsOrderLedger.History

open FsOrderLedger

let snapshots = ResizeArray<Versioned<Map<int, Order>>> ()

/// Appends one immutable snapshot of the current orders; no Order record is copied.
let record (orders: Order seq) : unit =
    let state = orders |> Seq.map (fun order -> order.Id, order) |> Map.ofSeq
    let versioned = { Version = snapshots.Count + 1; Value = state }
    snapshots.Add versioned
