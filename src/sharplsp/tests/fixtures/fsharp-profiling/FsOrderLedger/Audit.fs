// FsOrderLedger audit trail: a MailboxProcessor whose loop parks on a gate while paused, so
// posted entries pile up in its unbounded queue - the mailbox-growth leak this fixture profiles.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsOrderLedger.Audit

open System
open System.Threading
open FsOrderLedger

let private running = new ManualResetEventSlim(true)
let private parked = new ManualResetEventSlim(false)
let mutable private paused = 0
let mutable private queued = 0

let private waitUntil (condition: unit -> bool) (timeoutMs: int) : bool =
    let deadline = Environment.TickCount64 + int64 timeoutMs
    let mutable settled = condition ()
    while not settled && Environment.TickCount64 < deadline do
        Thread.Sleep 1
        settled <- condition ()
    settled

let private consume (entry: AuditEntry) : unit =
    Interlocked.Decrement(&queued) |> ignore
    ignore entry

let private loop (inbox: MailboxProcessor<AuditEntry>) : Async<unit> =
    async {
        while true do
            if Volatile.Read(&paused) = 1 then
                parked.Set()
                running.Wait()
                parked.Reset()
            else
                let! received = inbox.TryReceive 25
                match received with
                | Some entry -> consume entry
                | None -> ()
    }

let auditor = MailboxProcessor<AuditEntry>.Start loop

let isPaused () : bool = Volatile.Read(&paused) = 1

let queuedCount () : int = Volatile.Read(&queued)

let whenDrained (timeoutMs: int) : unit =
    waitUntil (fun () -> Volatile.Read(&queued) = 0) timeoutMs |> ignore

/// Posts one audit entry; while paused it stays in the mailbox queue.
let post (orderId: int) : unit =
    let entry = { At = DateTime.UtcNow; OrderId = orderId; Note = sprintf "order %d placed" orderId }
    Interlocked.Increment(&queued) |> ignore
    auditor.Post entry

/// Closes the gate and waits until the loop is provably parked, so further posts queue up.
let pause () : unit =
    Volatile.Write(&paused, 1)
    running.Reset()
    waitUntil (fun () -> parked.IsSet) 2_000 |> ignore

/// Opens the gate and waits for the queue to drain (or for the bounded timeout to elapse).
let resume () : unit =
    Volatile.Write(&paused, 0)
    running.Set()
    waitUntil (fun () -> not parked.IsSet) 2_000 |> ignore
    whenDrained 5_000
