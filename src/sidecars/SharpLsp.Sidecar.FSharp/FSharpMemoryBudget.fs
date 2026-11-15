/// The F# sidecar's memory budget: FCS keeps every project builder, typed tree and check
/// result it has made, so a long editing session grows until something trims it. Above
/// the soft limit the checker drops its caches and rebuilds on demand; still above the
/// hard limit afterwards, the sidecar exits so the host restarts it fresh rather than let
/// it swap the machine. Implements [SIDECAR-PROCESS-MEMORY] (GitHub #566).
module SharpLsp.Sidecar.FSharp.FSharpMemoryBudget

open System
open System.Diagnostics
open System.Threading
open Serilog

/// The resident-set limits, in bytes, the sidecar keeps under.
type Budget = { SoftBytes: int64; HardBytes: int64 }

/// What one budget check did.
type Verdict =
    | Within
    | Trimmed
    | OverHardLimit

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

/// The sidecar's resident set, in bytes.
let residentBytes () =
    use self = Process.GetCurrentProcess()
    self.WorkingSet64

/// Drop every cached builder and check result, then hand the memory back.
let private trim (state: FSharpWorkspace.FSharpWorkspaceState) =
    state.Checker.InvalidateAll()
    state.Checker.ClearLanguageServiceRootCachesAndCollectAndFinalizeAllTransients()

/// Measure, trim when over the soft limit, and say whether the hard limit still holds.
let enforce (state: FSharpWorkspace.FSharpWorkspaceState) (budget: Budget) (measure: unit -> int64) =
    let before = measure ()

    if before <= budget.SoftBytes then
        Within
    else
        trim state
        let after = measure ()
        Log.Warning("F# sidecar over its memory budget: {Before} -> {After} bytes, soft {Soft}, hard {Hard}",
                    before, after, budget.SoftBytes, budget.HardBytes)
        if after > budget.HardBytes then OverHardLimit else Trimmed

/// How often the running sidecar checks its budget.
let private interval = TimeSpan.FromSeconds 30.0

/// Exit code of a sidecar that stopped over its hard limit; the host restarts it.
[<Literal>]
let OverLimitExitCode = 3

let private onTick state budget =
    match enforce state budget residentBytes with
    | OverHardLimit ->
        Log.Error("F# sidecar exceeds its hard memory limit after trimming; exiting for a restart")
        Log.CloseAndFlush()
        Environment.Exit OverLimitExitCode
    | Within
    | Trimmed -> ()

/// Check the budget every interval for the life of the returned timer.
let start (state: FSharpWorkspace.FSharpWorkspaceState) : IDisposable =
    let budget = configuredBudget ()
    new Timer((fun _ -> onTick state budget), null, interval, interval)
