module FsStorefront.Catalog

open System.Globalization

let private adjectives = [| "Ergonomic"; "Rustic"; "Sleek"; "Vintage" |]
let private nouns = [| "Keyboard"; "Lamp"; "Backpack"; "Kettle"; "Monitor" |]

let private row index =
    let name = $"{adjectives[index % adjectives.Length]} {nouns[index % nouns.Length]}"
    let price = (9.99m + decimal (index % 90)).ToString CultureInfo.InvariantCulture
    $"SKU-%05d{index},{name},{price}"

/// The catalog as CSV, one product per line.
let generate itemCount = List.init itemCount row |> String.concat "\n"
