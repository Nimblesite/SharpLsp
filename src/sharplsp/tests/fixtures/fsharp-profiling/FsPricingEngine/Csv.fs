// FsPricingEngine CSV ingestion: a synthetic 2,000-row catalogue plus the active patterns the
// parser uses to validate each field. Malformed rows are dropped rather than thrown.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsPricingEngine.Csv

open System
open System.Globalization
open System.Text
open FsPricingEngine.Domain

let private invariant = CultureInfo.InvariantCulture

let (|Int|_|) (text: string) =
    match Int32.TryParse(text, NumberStyles.Integer, invariant) with
    | true, value -> Some value
    | _ -> None

let (|Money|_|) (text: string) =
    match Decimal.TryParse(text, NumberStyles.Number, invariant) with
    | true, value -> Some value
    | _ -> None

let (|SkuCode|_|) (text: string) =
    match text with
    | candidate when not (String.IsNullOrEmpty candidate) && candidate.StartsWith("SKU-", StringComparison.Ordinal) ->
        Some(Sku candidate)
    | _ -> None

let parseLine (line: string) : Product option =
    match line.Split([| ',' |]) with
    | [| SkuCode sku; name; Money price; Int stock; category |] ->
        Some { Sku = sku; Name = name; Price = price; Stock = stock; Category = category }
    | _ -> None

let parseAll (text: string) : Product list =
    text.Split([| '\n' |], StringSplitOptions.RemoveEmptyEntries)
    |> Array.toList
    |> List.choose parseLine

/// Builds the synthetic catalogue CSV once, at startup. Every 37th row is malformed on purpose
/// so `parseLine` exercises both branches of the active patterns.
let synthetic () : string =
    let builder = StringBuilder()
    builder.AppendLine("sku,name,price,stock,category") |> ignore
    for index in 1 .. 2_000 do
        let price = decimal (index % 89 + 1) + decimal (index % 100) / 100M
        let priceText = price.ToString("0.00", invariant)
        let category = index % 12
        if index % 37 = 0 then
            builder.AppendLine($"SKU-{index:D5},Item {index},not-a-price,{index % 250},Cat{category}") |> ignore
        else
            builder.AppendLine($"SKU-{index:D5},Item {index},{priceText},{index % 250},Cat{category}") |> ignore
    builder.ToString()
