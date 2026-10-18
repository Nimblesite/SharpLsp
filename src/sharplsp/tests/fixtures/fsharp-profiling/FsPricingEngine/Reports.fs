// FsPricingEngine reporting: daily totals built from a `seq { ... }` of synthetic orders and an
// async report builder that yields inside its loop so profiler frames interleave asynchronously.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsPricingEngine.Reports

open System
open System.Threading.Tasks
open FsPricingEngine.Domain

type DailyTotal = { Day: DateTime; OrderCount: int; Revenue: decimal }

let syntheticOrders (catalogue: Map<Sku, Product>) (count: int) : Order seq =
    let pool = catalogue |> Map.toList |> List.map fst |> List.truncate 24 |> Array.ofList
    if Array.isEmpty pool then
        Seq.empty
    else
        seq {
            for index in 0 .. count - 1 ->
                { Id = index
                  PlacedOn = DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(float (index % 30))
                  Lines =
                    [ for offset in 0 .. index % 4 ->
                          { Product = pool.[(index + offset) % pool.Length]
                            Quantity = 1 + (index + offset) % 3 } ] }
        }

let dailyTotals (catalogue: Map<Sku, Product>) (orders: Order seq) : DailyTotal list =
    seq {
        for day, dayOrders in orders |> Seq.groupBy (fun order -> order.PlacedOn.Date) ->
            { Day = day
              OrderCount = Seq.length dayOrders
              Revenue = dayOrders |> Seq.sumBy (fun order -> Pricing.subtotal catalogue order.Lines) }
    }
    |> Seq.sortBy (fun total -> total.Day)
    |> Seq.toList

/// Builds the report table asynchronously, yielding on every row.
let buildAsync (orders: Order seq) : Task<int> =
    task {
        let rows = orders |> Seq.toArray
        let total = ref 0
        for order in rows do
            do! Task.Yield()
            total.Value <- total.Value + order.Lines.Length
        return total.Value
    }
