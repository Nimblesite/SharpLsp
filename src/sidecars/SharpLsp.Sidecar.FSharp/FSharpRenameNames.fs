/// Symbol-kind-specific validation for F# rename. [RENAME-FSHARP-APPLY]
module SharpLsp.Sidecar.FSharp.FSharpRenameNames

open System
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open SharpLsp.Sidecar.FSharp.FSharpRenameToken

let private allowsSymbolName (symbol: FSharpSymbol) (newName: string) =
    let first = if newName.StartsWith("``", StringComparison.Ordinal) then newName[2] else newName[0]
    match symbol with
    | :? FSharpUnionCase as unionCase ->
        Char.IsUpper(first) || unionCase.DeclaringEntity.HasAttribute<RequireQualifiedAccessAttribute>()
    | :? FSharpEntity as entity when entity.IsFSharpExceptionDeclaration -> Char.IsUpper(first)
    | _ -> true

let isValidNewName checker (symbol: FSharpSymbol) (token: SourceToken) (newName: string) =
    if String.IsNullOrWhiteSpace(newName) then false
    else
        let genericPrefix =
            match symbol with
            | :? FSharpGenericParameter as parameter ->
                if parameter.IsSolveAtCompileTime then "^" else "'"
            | _ -> ""
        let genericName =
            newName.StartsWith("'", StringComparison.Ordinal)
            || newName.StartsWith("^", StringComparison.Ordinal)
        let compilerName =
            match token.Kind with
            | OperatorToken -> true
            | IdentifierToken when genericName -> PrettyNaming.IsIdentifierName(newName.Substring(1))
            | IdentifierToken ->
                PrettyNaming.IsIdentifierName(newName)
                || (newName.Length > 4
                    && newName.StartsWith("``", StringComparison.Ordinal)
                    && newName.EndsWith("``", StringComparison.Ordinal))
        newName <> "_"
        && newName <> token.Text
        && (if genericPrefix = "" then not genericName
            elif genericPrefix = "^" then genericName
            else newName.StartsWith(genericPrefix, StringComparison.Ordinal))
        && compilerName
        && allowsSymbolName symbol newName
        && classifyName checker newName = Some token.Kind

