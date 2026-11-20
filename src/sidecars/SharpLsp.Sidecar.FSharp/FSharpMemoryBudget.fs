/// The F# sidecar's memory budget: FCS keeps every project builder, typed tree and check
/// result it has made, so a long editing session grows until something trims it. Above
/// the soft limit the checker drops its caches and rebuilds on demand, and the limit
/// rises past the level it trimmed at, so a workspace that needs that much is trimmed
/// once. Still above the hard limit afterwards, a sidecar past its loading grace exits
/// so the host restarts it fresh rather than let it swap the machine; within the grace,
/// the size it trimmed to is the workspace's proven floor and the hard limit rises past it.
/// Implements [SIDECAR-PROCESS-MEMORY] (GitHub #566).
module SharpLsp.Sidecar.FSharp.FSharpMemoryBudget

open System
open System.Diagnostics
open System.Threading
open Serilog

/// The limits, in bytes, on the memory the sidecar holds.
type Budget = { SoftBytes: int64; HardBytes: int64 }

/// The environment variable that sets the soft limit in megabytes; the hard limit is twice it.
[<Literal>]
let LimitVariable = "SHARPLSP_FSHARP_MEMORY_LIMIT_MB"

let private megabytes (value: int64) = value * 1024L * 1024L

let private budgetOf softMegabytes =
    { SoftBytes = megabytes softMegabytes; HardBytes = megabytes (softMegabytes * 2L) }

/// 2 GB soft, 4 GB hard: a fully checked twelve-project F# repository settles near
/// 1.5 GB, so the default never trims a healthy workspace into a rebuild loop.
let defaultBudget = budgetOf 2048L

/// The budget `setting` (megabytes) asks for; a missing, malformed or non-positive
/// setting keeps the default.
let budgetFrom (setting: string option) =
    match setting |> Option.map Int64.TryParse with
    | Some(true, value) when value > 0L -> budgetOf value
    | _ -> defaultBudget

/// The budget the process environment configures.
let configuredBudget () =
    Environment.GetEnvironmentVariable LimitVariable |> Option.ofObj |> budgetFrom

/// The memory the sidecar holds, in bytes: the larger of its resident set and the heap
/// the collector has committed. The resident set alone reads low once the OS compresses
/// or swaps an idle sidecar's pages (141 MB resident for 2.2 GB committed), which is
/// exactly when the budget has to act.
let heldBytes () =
    use self = Process.GetCurrentProcess()
    max self.WorkingSet64 (GC.GetGCMemoryInfo().TotalCommittedBytes)

/// Drop every cached builder, check result and referenced entity, then hand the memory back.
let private trim (state: FSharpWorkspace.FSharpWorkspaceState) =
    state.Entities.Clear()
    state.Checker.InvalidateAll()
    state.Checker.ClearLanguageServiceRootCachesAndCollectAndFinalizeAllTransients()

/// The readings either side of a trim, when `measure` reads over the soft limit.
let private trimmed (state: FSharpWorkspace.FSharpWorkspaceState) (budget: Budget) (measure: unit -> int64) =
    let before = measure ()

    if before <= budget.SoftBytes then
        None
    else
        trim state
        let after = measure ()
        Log.Warning("F# sidecar over its memory budget: {Before} -> {After} bytes, soft {Soft}, hard {Hard}",
                    before, after, budget.SoftBytes, budget.HardBytes)
        Some(before, after)

/// How often the running sidecar checks its budget.
let private interval = TimeSpan.FromSeconds 30.0

/// Exit code of a sidecar that stopped over its hard limit; the host restarts it.
[<Literal>]
let OverLimitExitCode = 3

/// How long a fresh sidecar gets to load its workspace before a hard-limit breach exits it.
let GraceForLoading = TimeSpan.FromMinutes 10.0

/// `budget` with its soft limit an eighth of the hard limit above `before`, the level a
/// trim just answered: only growth past it is worth trimming again.
let private raisedPast (before: int64) (budget: Budget) =
    { budget with SoftBytes = before + budget.HardBytes / 8L }

/// One check of a running sidecar of the given `age`, returning the budget the next
/// check keeps. A trim raises the soft limit past the level it answered, so a workspace
/// that settles there keeps its caches instead of losing them every check. Over the hard
/// limit after trimming while younger than `GraceForLoading`, the workspace is simply
/// that large: the size it trimmed to is its proven floor, the hard limit rises an eighth
/// past it, and it keeps serving — a restart would reload straight back to it, in a loop.
/// Older and still over the hard limit after trimming, `stop` ends the process with
/// `OverLimitExitCode` so the host restarts it.
let watch state (budget: Budget) (age: TimeSpan) measure (stop: int -> unit) : Budget =
    match trimmed state budget measure with
    | None -> budget
    | Some(before, after) when after <= budget.HardBytes -> raisedPast before budget
    | Some(before, after) when age < GraceForLoading ->
        Log.Error("F# workspace needs more than the hard memory limit; raise {Variable} to stop trimming it",
                  LimitVariable)
        { raisedPast before budget with HardBytes = after + budget.HardBytes / 8L }
    | Some(before, _) ->
        Log.Error("F# sidecar exceeds its hard memory limit after trimming; exiting for a restart")
        stop OverLimitExitCode
        raisedPast before budget

let private exitProcess (code: int) =
    Log.CloseAndFlush()
    Environment.Exit code

/// Check the budget every interval for the life of the returned timer.
let start (state: FSharpWorkspace.FSharpWorkspaceState) : IDisposable =
    let mutable budget = configuredBudget ()
    let age = Stopwatch.StartNew()
    let tick _ = budget <- watch state budget age.Elapsed heldBytes exitProcess
    new Timer(tick, null, interval, interval)
