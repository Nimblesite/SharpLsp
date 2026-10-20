// FsOrderLedger console entry point: a line protocol on stdin/stdout that grows (or releases) the
// ledger's retained state, plus a "workload" thread that can drip orders and burn CPU on pricing.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsOrderLedger.Program

open System
open System.Diagnostics
open System.Threading
open FsOrderLedger

let blobs = ResizeArray<byte array> ()

let mutable private stopping = false
let mutable private dripOn = false
let mutable private burnOn = false
let mutable private nextQuoteSku = 0
let mutable private nextRejection = 0

let private placeOne () : Order =
    let order = Ledger.place (Ledger.nextId ())
    Bus.subscribe order.Id
    Bus.publish order
    Audit.post order.Id
    order

/// One drip tick: 20 orders, all inside the gate. The sleep is outside it so commands run.
let private dripTick () : unit =
    lock Gate.sync (fun () ->
        for _ in 1 .. 20 do
            placeOne () |> ignore)
    Thread.Sleep 50

/// One burn tick: one `priceAll` call. It only reads, under the ledger's own lock, so it takes no gate.
let private burnTick () : unit = Ledger.priceAll () |> ignore

let private workloadLoop () =
    while not (Volatile.Read(&stopping)) do
        let drip = Volatile.Read(&dripOn)
        let burn = Volatile.Read(&burnOn)
        if drip then dripTick ()
        if burn then burnTick ()
        if not (drip || burn) then Thread.Sleep 20

let private countsText () : string =
    let counted = Ledger.counts ()
    sprintf
        "orders=%d pending=%d paid=%d shipped=%d cancelled=%d handlers=%d audits=%d quotes=%d rejections=%d snapshots=%d blobs=%d"
        counted.Total
        counted.Pending
        counted.Paid
        counted.Shipped
        counted.Cancelled
        (Bus.handlers ())
        (Audit.queuedCount ())
        (Quotes.count ())
        Rejections.rejected.Count
        History.snapshots.Count
        blobs.Count

let private unknown (line: string) : string = sprintf "ERR unknown %s" line

/// One reply: the echoed command followed by every live count, always in the same order.
let private reply (echo: string) : string =
    if not (Audit.isPaused ()) then Audit.whenDrained 2_000
    sprintf "OK %s %s" echo (countsText ())

let private parseCount (text: string) : int option =
    match Int32.TryParse text with
    | true, value when value > 0 -> Some value
    | _ -> None

let private placeOrders (count: int) : unit =
    for _ in 1 .. count do
        placeOne () |> ignore

let private quoteSkus (count: int) : unit =
    for _ in 1 .. count do
        Quotes.quote (sprintf "SKU-Q%06d" (Volatile.Read(&nextQuoteSku))) |> ignore
        Volatile.Write(&nextQuoteSku, Volatile.Read(&nextQuoteSku) + 1)

let private rejectOrders (count: int) : unit =
    for _ in 1 .. count do
        Rejections.reject (Volatile.Read(&nextRejection))
        Volatile.Write(&nextRejection, Volatile.Read(&nextRejection) + 1)

let private retainBlob (mebibytes: int) : unit =
    blobs.Add(Array.zeroCreate<byte> (mebibytes * 1_048_576))

let private releaseAll () : unit =
    Ledger.release ()
    History.snapshots.Clear()
    blobs.Clear()
    Rejections.rejected.Clear()

let private countedAction (name: string) : (int -> unit) option =
    match name with
    | "place" -> Some placeOrders
    | "quote" -> Some quoteSkus
    | "reject" -> Some rejectOrders
    | "blob" -> Some retainBlob
    | _ -> None

let private stateAction (words: string list) : (unit -> unit) option =
    match words with
    | [ "history" ] -> Some(fun () -> History.record (Ledger.snapshot ()))
    | [ "audit"; "pause" ] -> Some Audit.pause
    | [ "audit"; "resume" ] -> Some Audit.resume
    | [ "release"; "orders" ] -> Some Ledger.release
    | [ "release"; "blobs" ] -> Some(fun () -> blobs.Clear())
    | [ "release"; "all" ] -> Some releaseAll
    | [ "drip"; "on" ] -> Some(fun () -> Volatile.Write(&dripOn, true))
    | [ "drip"; "off" ] -> Some(fun () -> Volatile.Write(&dripOn, false))
    | [ "burn"; "on" ] -> Some(fun () -> Volatile.Write(&burnOn, true))
    | [ "burn"; "off" ] -> Some(fun () -> Volatile.Write(&burnOn, false))
    | _ -> None

/// Runs `<name> <positive count>` commands; false when the words are not that shape.
let private applyCounted (words: string list) : bool =
    match words with
    | [ name; text ] ->
        match countedAction name, parseCount text with
        | Some action, Some count ->
            action count
            true
        | _ -> false
    | _ -> false

/// Runs one command and builds its reply; the caller holds `Gate.sync`.
let private runCommand (line: string) : string =
    let words = line.Split([| ' ' |], StringSplitOptions.RemoveEmptyEntries) |> List.ofArray
    let echo = String.Join(" ", words)
    if applyCounted words then
        reply echo
    else
        match stateAction words with
        | Some action ->
            action ()
            reply echo
        | None -> unknown line

/// Every command mutates, snapshots and replies under the one process-wide gate.
let private handle (line: string) : string = lock Gate.sync (fun () -> runCommand line)

let private isProcessAlive (pid: int) : bool =
    try
        use running = Process.GetProcessById pid
        not running.HasExited
    with :? ArgumentException -> false

let private watchParent () =
    match Environment.GetEnvironmentVariable "SHARPLSP_PROFILE_TARGET_PARENT_PID" with
    | null -> ()
    | supplied ->
        match Int32.TryParse supplied with
        | true, pid when pid > 0 ->
            let watchdog =
                Thread(
                    ThreadStart(fun () ->
                        while isProcessAlive pid do
                            Thread.Sleep 1_000
                        Environment.Exit 0)
                )
            watchdog.IsBackground <- true
            watchdog.Name <- "parent-death-watchdog"
            watchdog.Start()
        | _ -> ()

let private replyLine (text: string) =
    Console.Out.WriteLine text
    Console.Out.Flush()

[<EntryPoint>]
let main _ =
    Console.Out.WriteLine(sprintf "READY %d" Environment.ProcessId)
    Console.Out.Flush()
    watchParent ()
    let workload = Thread(ThreadStart workloadLoop)
    workload.IsBackground <- true
    workload.Name <- "workload"
    workload.Start()
    let mutable reading = true
    while reading do
        match Console.In.ReadLine() with
        | null -> reading <- false
        | line -> replyLine (handle line)
    Volatile.Write(&stopping, true)
    0
