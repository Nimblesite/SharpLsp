#r @"C:\Users\chris\.nuget\packages\fsharp.compiler.service\43.12.204\lib\netstandard2.0\FSharp.Compiler.Service.dll"

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text

let source = """
open System.Reflection

[<DefaultMember("Item")>]
type IndexerThing() =
    member _.Item
        with get(index: int) = index + 1

let first = IndexerThing().[0]
let second = IndexerThing().Item(1)
"""

let checker = FSharpChecker.Create()
let filePath = __SOURCE_DIRECTORY__ + "\\IndexerProbe.fsx"
let options, _ =
    checker.GetProjectOptionsFromScript(
        filePath,
        SourceText.ofString source,
        useSdkRefs = true,
        assumeDotNetFramework = false)
    |> Async.RunSynchronously

let parse, answer =
    checker.ParseAndCheckFileInProject(filePath, 0, SourceText.ofString source, options)
    |> Async.RunSynchronously

match answer with
| FSharpCheckFileAnswer.Aborted -> printfn "ABORTED"
| FSharpCheckFileAnswer.Succeeded check ->
    for diagnostic in check.Diagnostics do
        printfn "DIAG %d %s %A" diagnostic.ErrorNumber diagnostic.Message diagnostic.Range
    for symbolUse in check.GetAllUsesOfAllSymbolsInFile() do
        let r = symbolUse.Range
        printfn "USE %s %s def=%b %d:%d-%d:%d"
            (symbolUse.Symbol.GetType().Name)
            symbolUse.Symbol.DisplayName
            symbolUse.IsFromDefinition
            r.StartLine r.StartColumn r.EndLine r.EndColumn
    ([], parse.ParseTree)
    ||> ParsedInput.fold (fun acc path node ->
        match node with
        | SyntaxNode.SynExpr expr ->
            printfn "EXPR %A range=%A path=%d" expr.Range expr.Range path.Length
        | _ -> ()
        acc)
    |> ignore
