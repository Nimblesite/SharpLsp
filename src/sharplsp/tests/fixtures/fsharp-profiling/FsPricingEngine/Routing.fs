// FsPricingEngine delivery routing: a synthetic 400-node road graph and Dijkstra's algorithm
// with an immutable `Set<float * int>` as the priority queue.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsPricingEngine.Routing

open System

type Graph = Map<int, (int * float) list>

let nodeCount = 400

let private build (nodes: int) : Graph =
    let random = Random 42
    [ for node in 0 .. nodes - 1 ->
          let ringCost = 1.0 + float (node % 7)
          let ring = (node + 1) % nodes, ringCost
          let shortcuts =
              [ for _ in 1 .. 3 ->
                    let target = random.Next nodes
                    target, 1.0 + random.NextDouble() * 9.0 ]
          node, (ring :: shortcuts) |> List.distinctBy fst ]
    |> Map.ofList

let graph : Graph = build nodeCount

/// Shortest-path cost from `source` to `target`; `infinity` when the target is unreachable.
let shortestPath (roads: Graph) (source: int) (target: int) : float =
    let rec visit (queue: Set<float * int>) (distances: Map<int, float>) : Map<int, float> =
        if Set.isEmpty queue then
            distances
        else
            let cost, node = Set.minElement queue
            let queue = Set.remove (cost, node) queue
            match Map.tryFind node distances with
            | Some known when known < cost -> visit queue distances
            | _ ->
                let relax (found: Map<int, float>, pending: Set<float * int>) (next: int, weight: float) =
                    let candidate = cost + weight
                    match Map.tryFind next found with
                    | Some known when known <= candidate -> found, pending
                    | _ -> Map.add next candidate found, Set.add (candidate, next) pending
                let found, pending =
                    roads |> Map.tryFind node |> Option.defaultValue [] |> List.fold relax (distances, queue)
                visit pending found
    let distances = visit (Set.singleton (0.0, source)) (Map.ofList [ source, 0.0 ])
    distances |> Map.tryFind target |> Option.defaultValue infinity
