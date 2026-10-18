// FsOrderLedger order storage: every placed order is retained in a module-level ResizeArray.
// Each allocation site (CustomerId, Paid, Shipped, Cancelled, OrderLine, Order) sits on its own
// source line so a profiler can anchor that exact type to that exact line.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsOrderLedger.Ledger

open FsOrderLedger

type Counts =
    { Total: int
      Pending: int
      Paid: int
      Shipped: int
      Cancelled: int }

let orders = ResizeArray<Order> ()

let private storage = obj ()
let mutable private allocated = 0

let private skuFor (id: int) : string = sprintf "SKU-%05d" (id % 400)

/// The next order id: 0 first, then +1 forever, never reused.
let nextId () : int =
    lock storage (fun () ->
        let id = allocated
        allocated <- id + 1
        id)

/// Builds ONE order, appends it to `orders` and returns it.
let place (id: int) : Order =
    let customer = CustomerId(id % 5_000)
    let status =
        match id % 4 with
        | 0 -> Pending
        | 1 -> Paid(sprintf "PAY-%06d" id)
        | 2 -> Shipped(sprintf "CARRIER-%d" (id % 3), sprintf "TRACK-%08d" id)
        | _ -> Cancelled(sprintf "customer %d cancelled" (id % 97))
    let unitPrice = Cents(int64 (100 + id % 900))
    let line = { Sku = skuFor id; Quantity = 1 + id % 4; UnitPrice = unitPrice }
    let shipTo = { Street = sprintf "%d Market Street" id; Postcode = 1_000 + id % 9_000 }
    let order = { Id = id; Customer = customer; ShipTo = shipTo; Lines = [ line ]; Status = status; Payload = Array.zeroCreate 256 }
    lock storage (fun () -> orders.Add order)
    order

/// Drops every retained order; ids keep counting from where they were.
let release () : unit = lock storage (fun () -> orders.Clear())

let snapshot () : Order array = lock storage (fun () -> orders.ToArray())

let counts () : Counts =
    let current = snapshot ()
    let matching (predicate: OrderStatus -> bool) : int =
        current |> Array.filter (fun order -> predicate order.Status) |> Array.length
    { Total = current.Length
      Pending = matching (function Pending -> true | _ -> false)
      Paid = matching (function Paid _ -> true | _ -> false)
      Shipped = matching (function Shipped _ -> true | _ -> false)
      Cancelled = matching (function Cancelled _ -> true | _ -> false) }

/// Sums the decimal total of every retained order - the `burn` workload's tight loop.
let priceAll () : decimal =
    let current = snapshot ()
    let mutable total = 0M
    for order in current do
        for line in order.Lines do
            let (Cents cents) = line.UnitPrice
            total <- total + decimal cents * decimal line.Quantity
    total
