/// Symbol-kind-specific validation for F# rename. [RENAME-FSHARP-APPLY]
module SharpLsp.Sidecar.FSharp.FSharpRenameNames

open System
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open SharpLsp.Sidecar.FSharp.FSharpRenameToken

let private allowsSymbolName (symbol: FSharpSymbol) (newName: string) =
    let first = if newName.StartsWith("``", StringComparison.Ordinal) then newName[2] else newName[0]
    match symbol with
    | :? FSharpUnionCase as unionCase ->
        Char.IsUpper(first) || unionCase.DeclaringEntity.HasAttribute<RequireQualifiedAccessAttribute>()
    | :? FSharpActivePatternCase -> Char.IsUpper(first)
    | :? FSharpEntity as entity when entity.IsFSharpExceptionDeclaration -> Char.IsUpper(first)
    | _ -> true

let private isInlineGenericParameter (parseResults: FSharpParseFileResults) (parameter: FSharpGenericParameter) =
    let location = parameter.DeclarationLocation
    let declaration = location.Start
    (false, parseResults.ParseTree)
    ||> ParsedInput.fold (fun found _ node ->
        match node with
        | SyntaxNode.SynBinding (SynBinding(isInline = isInline) as binding) ->
            found || (isInline && Range.rangeContainsPos binding.RangeOfHeadPattern declaration)
        | _ -> found)

let private validGenericPrefix parseResults (symbol: FSharpSymbol) (newName: string) =
    let quoted = newName.StartsWith("'", StringComparison.Ordinal)
    let caret = newName.StartsWith("^", StringComparison.Ordinal)
    match symbol with
    | :? FSharpGenericParameter as parameter ->
        quoted || (caret && (parameter.IsSolveAtCompileTime || isInlineGenericParameter parseResults parameter))
    | _ -> not quoted && not caret

let private compilerAcceptsName (checker: FSharpChecker) (token: SourceToken) (newName: string) =
    match token.Kind with
    | OperatorToken -> true
    | IdentifierToken when newName.StartsWith("'", StringComparison.Ordinal)
                           || newName.StartsWith("^", StringComparison.Ordinal) ->
        PrettyNaming.IsIdentifierName(newName.Substring(1))
    | IdentifierToken ->
        PrettyNaming.IsIdentifierName(newName)
        || (newName.Length > 4
            && newName.StartsWith("``", StringComparison.Ordinal)
            && newName.EndsWith("``", StringComparison.Ordinal)
            && (checker.TokenizeFile(newName) |> Array.sumBy Array.length) = 1)

let isValidNewName parseResults checker (symbol: FSharpSymbol) (token: SourceToken) (newName: string) =
    not (String.IsNullOrWhiteSpace(newName))
    && newName <> "_"
    && newName <> token.Text
    && validGenericPrefix parseResults symbol newName
    && compilerAcceptsName checker token newName
    && allowsSymbolName symbol newName
    && classifyName checker newName = Some token.Kind

