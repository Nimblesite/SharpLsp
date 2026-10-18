// FsPricingEngine pricing: line and basket totals plus a recursive discount rule engine that
// pattern-matches every `Discount` case. All money is `decimal`, rounded banker's-style.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsPricingEngine.Pricing

open System
open FsPricingEngine.Domain

let private round2 (value: decimal) : decimal =
    Math.Round(value, 2, MidpointRounding.ToEven)

let unitPrice (catalogue: Map<Sku, Product>) (sku: Sku) : decimal =
    catalogue |> Map.tryFind sku |> Option.map (fun product -> product.Price) |> Option.defaultValue 0M

let lineTotal (catalogue: Map<Sku, Product>) (line: BasketLine) : decimal =
    unitPrice catalogue line.Product * decimal line.Quantity

let subtotal (catalogue: Map<Sku, Product>) (lines: BasketLine list) : decimal =
    lines |> List.map (lineTotal catalogue) |> List.sum

let private percentOf (percent: decimal) (amount: decimal) : decimal =
    round2 (amount * percent / 100M)

let private buyXGetY (catalogue: Map<Sku, Product>) (lines: BasketLine list) (buy: int, free: int) : decimal =
    if buy <= 0 || free <= 0 then
        0M
    else
        lines
        |> List.sumBy (fun line -> decimal (line.Quantity / (buy + free) * free) * unitPrice catalogue line.Product)
        |> round2

let private bundle (catalogue: Map<Sku, Product>) (lines: BasketLine list) (items: Sku list) (price: decimal) : decimal =
    match lines |> List.filter (fun line -> List.contains line.Product items) with
    | [] -> 0M
    | chosen -> round2 (max 0M (subtotal catalogue chosen - price))

let private tiered (catalogue: Map<Sku, Product>) (lines: BasketLine list) (tiers: (int * decimal) list) : decimal =
    let units = lines |> List.sumBy (fun line -> line.Quantity)
    tiers
    |> List.filter (fun (threshold, _) -> units >= threshold)
    |> List.sortBy fst
    |> List.tryLast
    |> Option.map (fun (_, percent) -> percentOf percent (subtotal catalogue lines))
    |> Option.defaultValue 0M

/// Walks the whole discount list recursively, matching every case of the union.
let rec applyRules (catalogue: Map<Sku, Product>) (lines: BasketLine list) (discounts: Discount list) : decimal =
    match discounts with
    | [] -> 0M
    | PercentOff percent :: rest ->
        percentOf percent (subtotal catalogue lines) + applyRules catalogue lines rest
    | BuyXGetY(buy, free) :: rest ->
        buyXGetY catalogue lines (buy, free) + applyRules catalogue lines rest
    | Bundle(items, price) :: rest ->
        bundle catalogue lines items price + applyRules catalogue lines rest
    | Tiered tiers :: rest ->
        tiered catalogue lines tiers + applyRules catalogue lines rest

let basketTotal
    (catalogue: Map<Sku, Product>)
    (lines: BasketLine list)
    (discounts: Discount list)
    (taxRate: decimal)
    : decimal =
    let discounted = subtotal catalogue lines - applyRules catalogue lines discounts
    let net = max 0M discounted
    Math.Round(net + net * taxRate, 2, MidpointRounding.ToEven)
