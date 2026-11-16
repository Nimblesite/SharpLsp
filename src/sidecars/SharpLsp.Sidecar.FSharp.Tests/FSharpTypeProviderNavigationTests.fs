/// Exploration.
module SharpLsp.Sidecar.FSharp.Tests.FSharpTypeProviderNavigationTests

open System
open Xunit
open FSharp.Compiler.Symbols
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCodeActionKit
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpImportFixTests

let private app =
    String.Join(
        "\n",
        [ "module App.Library"
          ""
          "open FSharp.Data"
          ""
          "type Weather = JsonProvider<\"\"\"{\"city\":\"Oslo\",\"temperature\":4.5}\"\"\">"
          ""
          "let sample = Weather.Parse(\"\"\"{\"city\":\"Rome\",\"temperature\":21.0}\"\"\")"
          "let city = sample.City"
          "" ])

[<Fact>]
let ``explore`` () =
    task {
        let! state, root = loadSolution [ projectXml "App" [] [ "FSharp.Core", "10.1.404"; "FSharp.Data", "6.6.0" ] |> fun (n, x) -> n, x, app ]
        try
            let path = libraryPath root "App"
            let! _, check, _ = checkedFixture state path
            let report = Text.StringBuilder()
            for d in check.Diagnostics do report.AppendLine($"DIAG {d.ErrorNumber} {d.Message}") |> ignore
            for u in check.GetAllUsesOfAllSymbolsInFile() do
                let extra =
                    match u.Symbol with
                    | :? FSharpEntity as e -> $"entity provided={e.IsProvided} erased={e.IsProvidedAndErased} abbr={e.IsFSharpAbbreviation} full={e.TryFullName}"
                    | :? FSharpMemberOrFunctionOrValue as m -> $"member declaring={m.DeclaringEntity |> Option.map (fun e -> e.DisplayName, e.IsProvided)}"
                    | _ -> ""
                report.AppendLine($"USE {u.Range.StartLine}:{u.Range.StartColumn} {u.Symbol.DisplayName} def={u.IsFromDefinition} loc={u.Symbol.DeclarationLocation} {extra}") |> ignore
            for (line, col) in [ (6, 15); (6, 22); (7, 20); (4, 16) ] do
                let! definition = FSharpWorkspace.getDefinition state path line col
                report.AppendLine($"DEF {line}:{col} -> {definition}") |> ignore
            failwith (report.ToString())
        finally
            cleanup root
    }
