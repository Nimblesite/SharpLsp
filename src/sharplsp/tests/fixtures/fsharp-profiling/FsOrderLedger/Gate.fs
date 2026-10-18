// FsOrderLedger's single process-wide gate. Commands arrive on the stdin thread while the
// "workload" thread drips orders and burns CPU, so every mutation, every workload tick and every
// reply snapshot runs inside this one lock: the counts a reply prints are then one consistent
// snapshot of the live heap, not a torn read.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsOrderLedger.Gate

/// The one process-wide lock. Hold it for a whole command, a whole drip burst, or one burn call.
let sync = obj ()
