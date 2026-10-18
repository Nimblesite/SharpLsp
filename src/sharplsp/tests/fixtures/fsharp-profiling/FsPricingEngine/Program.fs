// FsPricingEngine console entry point: a line protocol on stdin/stdout that points one
// dedicated "workload" thread at a single CPU-heavy retail workload, or at all of them in turn.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsPricingEngine.Program

open System
open System.Diagnostics
open System.Threading
open FsPricingEngine
open FsPricingEngine.Domain

[<NoEquality; NoComparison>]
type private Workload = { Name: string; Step: (unit -> unit) option }

let private gate = obj ()
let private current = ref { Name = "idle"; Step = None }
let mutable private completed = 0L
let mutable private stopping = false

let private csvText = Csv.synthetic ()
let private products = Csv.parseAll csvText
let private catalogue = products |> List.map (fun product -> product.Sku, product) |> Map.ofList
let private basket =
    products |> List.take 12 |> List.mapi (fun index product -> { Product = product.Sku; Quantity = 1 + index % 4 })
let private bundleSkus = products |> List.take 3 |> List.map (fun product -> product.Sku)
let private discounts =
    [ PercentOff 10M
      BuyXGetY(2, 1)
      Bundle(bundleSkus, 25M)
      Tiered [ (5, 5M); (10, 12M); (20, 18M) ] ]
let private orders = Reports.syntheticOrders catalogue 4_000

let private parseStep () = Csv.parseAll csvText |> List.length |> ignore

let private priceStep () = Pricing.basketTotal catalogue basket discounts 0.125M |> ignore

let private searchStep () = Search.rank "Item 1234" products |> List.truncate 10 |> List.length |> ignore

let private routeStep () = Routing.shortestPath Routing.graph 0 (Routing.nodeCount - 1) |> ignore

let private reportStep () =
    Reports.dailyTotals catalogue orders |> List.length |> ignore
    Reports.buildAsync orders |> fun pending -> pending.GetAwaiter().GetResult() |> ignore

let private mixedStep () =
    parseStep ()
    priceStep ()
    searchStep ()
    routeStep ()
    reportStep ()

let private workloadFor (name: string) : Workload option =
    match name with
    | "parse" -> Some { Name = name; Step = Some parseStep }
    | "price" -> Some { Name = name; Step = Some priceStep }
    | "search" -> Some { Name = name; Step = Some searchStep }
    | "route" -> Some { Name = name; Step = Some routeStep }
    | "report" -> Some { Name = name; Step = Some reportStep }
    | "mixed" -> Some { Name = name; Step = Some mixedStep }
    | _ -> None

let private idle = { Name = "idle"; Step = None }

let private readCurrent () = lock gate (fun () -> current.Value)

let private switchTo (workload: Workload) = lock gate (fun () -> current.Value <- workload)

let private iterations () = lock gate (fun () -> completed)

let private countIteration () = lock gate (fun () -> completed <- completed + 1L)

let private unknown (line: string) = sprintf "ERR unknown %s" line

let private replyRun (name: string) = sprintf "OK run %s iterations=%d" name (iterations ())

let private replyIdle () = sprintf "OK idle iterations=%d" (iterations ())

let private replyStats () =
    sprintf "OK stats workload=%s iterations=%d" (readCurrent ()).Name (iterations ())

let private handle (line: string) : string =
    match line.Split([| ' ' |], StringSplitOptions.RemoveEmptyEntries) |> List.ofArray with
    | [ "run"; name ] ->
        match workloadFor name with
        | Some workload ->
            switchTo workload
            replyRun name
        | None -> unknown line
    | [ "idle" ] ->
        switchTo idle
        replyIdle ()
    | [ "stats" ] -> replyStats ()
    | _ -> unknown line

let private workloadLoop () =
    while not (Volatile.Read(&stopping)) do
        match (readCurrent ()).Step with
        | None -> Thread.Sleep 20
        | Some step ->
            step ()
            countIteration ()

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

let private reply (line: string) =
    Console.Out.WriteLine line
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
        | line -> reply (handle line)
    Volatile.Write(&stopping, true)
    0
