// FsOrderLedger's single process-wide gate. Commands arrive on the stdin thread while the
// "workload" thread drips orders and burns CPU, so every mutation, every drip burst and every
// reply snapshot runs inside this one lock: the counts a reply prints are then one consistent
// snapshot of the live heap, not a torn read. A burn tick only reads, so it stays outside: the
// sampler stops a thread at its next safe point, and a lock taken on every tick drew the samples
// of the loop it guarded, which left `priceAll` under the hot-function threshold.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsOrderLedger.Gate

/// The one process-wide lock. Hold it for a whole command or a whole drip burst.
let sync = obj ()
