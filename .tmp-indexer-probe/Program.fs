open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open Microsoft.FSharp.Reflection

let source = """
open System.Reflection

type IndexerThing() =
    member _.Item
        with get(index: int) = index + 1
        and set(index: int) value = ignore (index + value)

let first = IndexerThing().[0]
let second = IndexerThing().Item(1)
let third = IndexerThing()
third.[0] <- 4

module Libraries =
    module Json =
        let value = 1
module Json = Libraries.Json
let encoded = Json.value
let direct = Libraries.Json.value
"""

let checker = FSharpChecker.Create()
let filePath = System.IO.Path.Combine(__SOURCE_DIRECTORY__, "IndexerProbe.fsx")

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
    let allUses = check.GetAllUsesOfAllSymbolsInFile() |> Seq.toArray
    for diagnostic in check.Diagnostics do
        printfn "DIAG %d %s %A" diagnostic.ErrorNumber diagnostic.Message diagnostic.Range
    for symbolUse in allUses do
        let r = symbolUse.Range
        printfn "USE %s %s def=%b %d:%d-%d:%d"
            (symbolUse.Symbol.GetType().Name)
            symbolUse.Symbol.DisplayName
            symbolUse.IsFromDefinition
            r.StartLine r.StartColumn r.EndLine r.EndColumn
        match symbolUse.Symbol with
        | :? FSharpMemberOrFunctionOrValue as memberValue when memberValue.DisplayName = "Item" ->
            printfn "  ITEM property=%b getter=%b entity=%A"
                memberValue.IsProperty memberValue.IsPropertyGetterMethod memberValue.DeclaringEntity
            for attribute in memberValue.DeclaringEntity.Value.Attributes do
                printfn "  ATTRIBUTE %s range=%A args=%A"
                    attribute.AttributeType.DisplayName attribute.Range attribute.ConstructorArguments
            if symbolUse.IsFromDefinition then
                for useOfItem in check.GetUsesOfSymbolInFile(memberValue) do
                    printfn "  GETUSES %s def=%b range=%A"
                        useOfItem.Symbol.DisplayName useOfItem.IsFromDefinition useOfItem.Range
        | _ -> ()
    ([], parse.ParseTree)
    ||> ParsedInput.fold (fun acc path node ->
        match node with
        | SyntaxNode.SynExpr expr ->
            printfn "EXPR %s range=%A path=%d" (expr.GetType().Name) expr.Range path.Length
            let case, fields = FSharpValue.GetUnionFields(expr, typeof<SynExpr>)
            if case.Name.Contains("Indexed") then
                printfn "  CASE %s" case.Name
                for field, value in Array.zip (case.GetFields()) fields do
                    printfn "  FIELD %s = %A" field.Name value
        | SyntaxNode.SynTypeDefn typeDefn ->
            let case, fields = FSharpValue.GetUnionFields(typeDefn, typeof<SynTypeDefn>)
            printfn "TYPECASE %s" case.Name
            for field, value in Array.zip (case.GetFields()) fields do
                printfn "  TYPEFIELD %s = %A" field.Name value
        | _ -> ()
        acc)
    |> ignore
