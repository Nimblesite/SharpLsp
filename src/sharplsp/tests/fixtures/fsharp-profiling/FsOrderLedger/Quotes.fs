// FsOrderLedger quotes: a memoizing closure whose Dictionary is captured and never evicted, so
// every distinct SKU ever quoted stays reachable - the cache-growth leak this fixture profiles.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsOrderLedger.Quotes

open System
open System.Collections.Generic
open System.Threading
open FsOrderLedger

/// Returns a memoized version of `compute`, backed by one Dictionary held by the closure.
let memoize (compute: string -> 'T) : string -> 'T =
    let cache = Dictionary<string, 'T>(StringComparer.Ordinal)
    fun key ->
        match cache.TryGetValue key with
        | true, cached -> cached
        | _ ->
            let computed = compute key
            cache.[key] <- computed
            computed

let mutable private cached = 0

/// Quotes are built once per distinct SKU (memoize only calls the lambda on a miss), so the
/// insertion counter equals the cache size exactly.
let quote =
    memoize (fun sku ->
        Interlocked.Increment(&cached) |> ignore
        let price = 10M + decimal (sku.Length % 17) * 1.5M
        let tags = if price > 20M then set [ "retail"; "premium" ] else set [ "retail" ]
        let quoted = { Sku = sku; Price = price; Tags = tags }
        quoted)

let count () : int = Volatile.Read(&cached)
