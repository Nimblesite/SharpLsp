// FsPricingEngine fuzzy search: Levenshtein distance over a 2D cost matrix (the dominant cost
// of the `search` workload) and a ranked ordering of catalogue products by that distance.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsPricingEngine.Search

open FsPricingEngine.Domain

let distance (left: string) (right: string) : int =
    let rows = left.Length
    let columns = right.Length
    let costs = Array2D.zeroCreate<int> (rows + 1) (columns + 1)
    for row in 0 .. rows do
        costs.[row, 0] <- row
    for column in 0 .. columns do
        costs.[0, column] <- column
    for column in 1 .. columns do
        for row in 1 .. rows do
            let substitution = if left.[row - 1] = right.[column - 1] then 0 else 1
            let deletion = costs.[row - 1, column] + 1
            let insertion = costs.[row, column - 1] + 1
            let diagonal = costs.[row - 1, column - 1] + substitution
            costs.[row, column] <- min deletion (min insertion diagonal)
    costs.[rows, columns]

let rank (query: string) (products: Product list) : Product list =
    products
    |> List.sortBy (fun product -> distance query product.Name, product.Price, product.Name)
