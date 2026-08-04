/// Parser-backed support for F# default indexed properties.
module SharpLsp.Sidecar.FSharp.FSharpRenameIndexers

open System
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open SharpLsp.Sidecar.FSharp.FSharpRenameToken

[<NoComparison; NoEquality>]
type IndexerSyntax =
    { UseRange: Range
      MarkerRange: Range }

[<NoComparison; NoEquality>]
type private TypeSyntax =
    { Attributes: SynAttribute list
      Anchor: Position }

/// Two FCS symbol instances for the same accessor come from separate reads, so
/// structural `Equals` does not hold. `IsEffectivelySameAs` is the compiler's own
/// identity test and is what links a getter back to its declaring property.
let private sameSymbol (left: FSharpSymbol) (right: FSharpSymbol) =
    left.IsEffectivelySameAs(right)

let private accessorOfProperty
    (memberValue: FSharpMemberOrFunctionOrValue)
    (property: FSharpMemberOrFunctionOrValue) =
    (property.HasGetterMethod && sameSymbol property.GetterMethod memberValue)
    || (property.HasSetterMethod && sameSymbol property.SetterMethod memberValue)

let private enclosingProperties (memberValue: FSharpMemberOrFunctionOrValue) =
    try
        match memberValue.ApparentEnclosingEntity with
        | Some entity -> entity.MembersFunctionsAndValues :> seq<_>
        | None -> Seq.empty
    with _ -> Seq.empty

let private normalizeMember (memberValue: FSharpMemberOrFunctionOrValue) =
    if memberValue.IsProperty then Some memberValue
    else
        enclosingProperties memberValue
        |> Seq.tryFind (fun property -> property.IsProperty && accessorOfProperty memberValue property)

let private parameterCount (memberValue: FSharpMemberOrFunctionOrValue) =
    memberValue.CurriedParameterGroups |> Seq.sumBy _.Count

/// FCS reports an `x.[i]` use — and the `member _.Item` declaration itself — as the
/// property's getter, and only that accessor carries the index parameters: the
/// property symbol's own parameter groups are empty. A getter that takes arguments
/// is therefore what distinguishes an indexed property from a plain one.
let private hasIndexParameters (property: FSharpMemberOrFunctionOrValue) =
    parameterCount property > 0
    || (property.HasGetterMethod && parameterCount property.GetterMethod > 0)

let tryNormalize (symbol: FSharpSymbol) =
    match symbol with
    | :? FSharpMemberOrFunctionOrValue as memberValue ->
        normalizeMember memberValue |> Option.filter hasIndexParameters
    | _ -> None

let normalizeSymbol (symbol: FSharpSymbol) =
    tryNormalize symbol |> Option.map (fun property -> property :> FSharpSymbol) |> Option.defaultValue symbol

let isIndexerSymbol symbol = tryNormalize symbol |> Option.isSome

let private markerRange (dotRange: Range) =
    let markerEnd = Position.mkPos dotRange.EndLine (dotRange.EndColumn + 1)
    Range.mkRange dotRange.FileName dotRange.Start markerEnd

let private syntaxForExpr = function
    | SynExpr.DotIndexedGet(dotRange = dotRange; range = useRange) ->
        Some { UseRange = useRange; MarkerRange = markerRange dotRange }
    | SynExpr.DotIndexedSet(leftOfSetRange = useRange; dotRange = dotRange) ->
        Some { UseRange = useRange; MarkerRange = markerRange dotRange }
    | _ -> None

let collectSyntaxes (parseResults: FSharpParseFileResults) =
    ([], parseResults.ParseTree)
    ||> ParsedInput.fold (fun found _ node ->
        match node with
        | SyntaxNode.SynExpr expr -> (syntaxForExpr expr |> Option.toList) @ found
        | _ -> found)
    |> List.toArray

let private rangeKey (range: Range) =
    range.FileName, range.StartLine, range.StartColumn, range.EndLine, range.EndColumn

let isImplicitUse (syntaxes: IndexerSyntax array) (symbolUse: FSharpSymbolUse) =
    isIndexerSymbol symbolUse.Symbol
    && syntaxes |> Array.exists (fun syntax -> rangeKey syntax.UseRange = rangeKey symbolUse.Range)

let private containsPosition line character (range: Range) =
    range.StartLine - 1 = line
    && range.StartColumn <= character
    && character < range.EndColumn

let private isClosingBracket line character (syntax: IndexerSyntax) =
    let range = syntax.UseRange
    range.EndLine - 1 = line && range.EndColumn - 1 = character

let private isIndexerPosition line character syntax =
    containsPosition line character syntax.MarkerRange
    || isClosingBracket line character syntax

let private useAtSyntax (checkResults: FSharpCheckFileResults) (syntax: IndexerSyntax) =
    checkResults.GetAllUsesOfAllSymbolsInFile()
    |> Seq.tryFind (fun symbolUse ->
        rangeKey symbolUse.Range = rangeKey syntax.UseRange
        && isIndexerSymbol symbolUse.Symbol)

let private syntheticToken (symbolUse: FSharpSymbolUse) (syntax: IndexerSyntax) =
    let property = tryNormalize symbolUse.Symbol |> Option.get
    { StartCharacter = syntax.MarkerRange.StartColumn
      EndCharacter = syntax.MarkerRange.EndColumn
      Text = property.DisplayName
      Kind = IdentifierToken }

let tryResolveAt checkResults parseResults line character =
    collectSyntaxes parseResults
    |> Array.filter (isIndexerPosition line character)
    |> Array.tryPick (fun syntax ->
        useAtSyntax checkResults syntax
        |> Option.map (fun symbolUse -> symbolUse, syntheticToken symbolUse syntax))

let private attributeFullName (attribute: FSharpAttribute) =
    attribute.AttributeType.TryFullName |> Option.defaultValue attribute.AttributeType.DisplayName

let private isDefaultMemberAttribute (attribute: FSharpAttribute) =
    attributeFullName attribute = "System.Reflection.DefaultMemberAttribute"

let private defaultMemberAttribute (property: FSharpMemberOrFunctionOrValue) =
    property.ApparentEnclosingEntity
    |> Option.bind (fun entity -> entity.Attributes |> Seq.tryFind isDefaultMemberAttribute)

let private flattenAttributes (lists: SynAttributeList list) =
    lists |> List.collect _.Attributes

let private typeSyntax (declarationRange: Range) = function
    | SynTypeDefn(
        typeInfo = SynComponentInfo(attributes = attributeLists)
        range = typeRange
        trivia = trivia) when Range.rangeContainsRange typeRange declarationRange ->
        let keywordRange = trivia.LeadingKeyword.Range
        let anchor =
            attributeLists
            |> List.tryHead
            |> Option.map (fun attributes ->
                let attributeRange = attributes.Range
                attributeRange.Start)
            |> Option.defaultValue keywordRange.Start
        Some { Attributes = flattenAttributes attributeLists; Anchor = anchor }
    | _ -> None

let private findTypeSyntax (parseResults: FSharpParseFileResults) (declarationRange: Range) =
    (None, parseResults.ParseTree)
    ||> ParsedInput.fold (fun found _ node ->
        match found, node with
        | Some _, _ -> found
        | None, SyntaxNode.SynTypeDefn definition -> typeSyntax declarationRange definition
        | _ -> None)

let rec private stringLiteral = function
    | SynExpr.Paren(expr = inner) -> stringLiteral inner
    | SynExpr.Const(SynConst.String(value, _, literalRange), _) -> Some(value, literalRange)
    | _ -> None

let private matchingAttribute attributeRange (attribute: SynAttribute) =
    rangeKey attribute.Range = rangeKey attributeRange

let private explicitLiteral (typeSyntax: TypeSyntax) (attribute: FSharpAttribute) oldName =
    typeSyntax.Attributes
    |> List.tryFind (matchingAttribute attribute.Range)
    |> Option.bind (fun syntax -> stringLiteral syntax.ArgExpr)
    |> Option.filter (fun (value, _) -> value = oldName)
    |> Option.map snd

let private logicalName (newName: string) =
    if newName.Length >= 4 && newName.StartsWith("``") && newName.EndsWith("``") then
        newName.Substring(2, newName.Length - 4)
    else newName

let private escapedLiteral newName =
    let escaped = logicalName newName |> fun name -> name.Replace("\\", "\\\\").Replace("\"", "\\\"")
    $"\"{escaped}\""

let private literalEdit filePath newName (range: Range) : FSharpCodeActions.RawEdit =
    { FilePath = filePath
      StartLine = range.StartLine - 1
      StartCharacter = range.StartColumn
      EndLine = range.EndLine - 1
      EndCharacter = range.EndColumn
      NewText = escapedLiteral newName }

let private insertionText column newName =
    let indentation = String(' ', column)
    $"[<System.Reflection.DefaultMemberAttribute({escapedLiteral newName})>]\n{indentation}"

let private insertionEdit filePath newName (typeSyntax: TypeSyntax) : FSharpCodeActions.RawEdit =
    let position = typeSyntax.Anchor
    { FilePath = filePath
      StartLine = position.Line - 1
      StartCharacter = position.Column
      EndLine = position.Line - 1
      EndCharacter = position.Column
      NewText = insertionText position.Column newName }

let private isImplicitDefaultName name =
    name = "Item" || name = "op_IndexedLookup"

let private planForType filePath parseResults (property: FSharpMemberOrFunctionOrValue) newName =
    let declarationRange = property.DeclarationLocation
    match findTypeSyntax parseResults declarationRange with
    | None -> Error "Indexer declaring type was not found in the parse tree"
    | Some syntax ->
        match defaultMemberAttribute property with
        | Some attribute ->
            explicitLiteral syntax attribute property.DisplayName
            |> Option.map (literalEdit filePath newName >> List.singleton >> Ok)
            |> Option.defaultValue (Error "DefaultMember metadata is not a writable string literal")
        | None when isImplicitDefaultName property.DisplayName ->
            Ok [ insertionEdit filePath newName syntax ]
        | None -> Error "Indexer has no DefaultMember metadata"

let planMetadata (state: FSharpWorkspace.FSharpWorkspaceState) symbol newName =
    task {
        match tryNormalize symbol with
        | None -> return Ok []
        | Some property ->
            let declarationRange = property.DeclarationLocation
            let filePath = declarationRange.FileName
            let! checkedFile = FSharpWorkspace.checkFileWithParse state filePath
            match checkedFile with
            | None -> return Error $"FCS could not check {filePath}"
            | Some(parseResults, _, _) ->
                return planForType filePath parseResults property newName
    }
