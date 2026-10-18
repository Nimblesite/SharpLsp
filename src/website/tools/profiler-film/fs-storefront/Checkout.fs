module FsStorefront.Checkout

open System
open System.Globalization

let private toProduct (line: string) =
    match line.Split ',' with
    | [| sku; name; price |] -> Some { Sku = sku; Name = name; Price = Decimal.Parse(price, CultureInfo.InvariantCulture) }
    | _ -> None

let parseCatalog (csv: string) = csv.Split '\n' |> Array.choose toProduct |> List.ofArray

let pickBasket seed products =
    let random = Random seed
    products |> List.sortBy (fun _ -> random.Next()) |> List.truncate 12

let private applyDiscounts product =
    let hash = Seq.fold (fun hash round -> (hash * 31) ^^^ int product.Sku[round % product.Sku.Length]) 17 (seq { 0..4_999 })
    if hash % 7 = 0 then product.Price * 0.9m else product.Price

let priceBasket basket = basket |> List.sumBy applyDiscounts

let renderInvoice orderId basket total =
    let lines = basket |> List.map (fun p -> sprintf "%-12s%-28s%10.2f" p.Sku p.Name p.Price)
    sprintf "INVOICE #%d\n%s\nTOTAL %.2f" orderId (String.concat "\n" lines) total

let checkout catalog orderId =
    let basket = parseCatalog catalog |> pickBasket orderId
    let total = priceBasket basket
    { Id = orderId; Items = basket; Total = total; Invoice = renderInvoice orderId basket total }
