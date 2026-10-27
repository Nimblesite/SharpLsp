/// F# "Implement interface" stubs: FCS `InterfaceStubGenerator` fills in the
/// members an `interface IFoo with` block (or object expression) has yet to
/// implement. Pure generation, like the union and record stubs in
/// FSharpCodeActions; FSharpCodeFixes wraps the result with its caching.
/// Implements [ANALYZERS-FSAC-CODEFIX-INTERFACE-STUB].
module SharpLsp.Sidecar.FSharp.FSharpInterfaceStubs

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open Serilog
open SharpLsp.Sidecar.FSharp.FSharpCodeActions

// ── Interface implementation stub generation ────────────────────
// [ANALYZERS-FSAC-CODEFIX-INTERFACE-STUB] Completes the stub-generation trio (union / record /
// interface) using FCS `InterfaceStubGenerator` — FSAC parity. Given the cursor on
// an `interface IFoo with` declaration, generate stubs for the not-yet-implemented
// members (`member _.X ... = failwith "..."`).

/// Resolve the interface entity for an `interface … with` block: the first symbol
/// use inside the declaration range whose symbol is an interface entity.
let private resolveInterfaceEntity
    (checkResults: FSharpCheckFileResults)
    (interfaceRange: Range)
    : FSharpSymbolUse option =
    checkResults.GetAllUsesOfAllSymbolsInFile()
    |> Seq.filter (fun symbolUse ->
        match symbolUse.Symbol with
        | :? FSharpEntity as entity ->
            InterfaceStubGenerator.IsInterface entity
            && Range.rangeContainsRange interfaceRange symbolUse.Range
        | _ -> false)
    |> Seq.sortBy (fun symbolUse ->
        let symbolRange = symbolUse.Range
        symbolRange.StartLine, symbolRange.StartColumn)
    |> Seq.tryHead

[<NoComparison; NoEquality>]
type private InterfaceSyntax =
    { StartColumn: int
      WithKeyword: Range option
      TypeRange: Range }

[<NoComparison; NoEquality>]
type private InterfaceInsertion =
    { StartColumn: int
      InsertAt: Position
      InsertWith: bool }

[<NoComparison; NoEquality>]
type private InterfaceContext =
    { Data: InterfaceData
      Syntax: InterfaceSyntax option
      EntityRange: Range }

let private lastBindingOfMember = function
    | SynMemberDefn.Member(memberDefn = binding) -> Some binding
    | SynMemberDefn.GetSetMember(
        memberDefnForGet = Some(SynBinding(range = getRange) as getter)
        memberDefnForSet = Some(SynBinding(range = setRange) as setter)) ->
        if (getRange.EndLine, getRange.EndColumn) < (setRange.EndLine, setRange.EndColumn) then
            Some setter
        else Some getter
    | SynMemberDefn.GetSetMember(memberDefnForGet = Some binding; memberDefnForSet = None)
    | SynMemberDefn.GetSetMember(memberDefnForGet = None; memberDefnForSet = Some binding) ->
        Some binding
    | _ -> None

let private tryLastBinding = function
    | InterfaceData.Interface(_, Some members) ->
        members |> List.choose lastBindingOfMember |> List.tryLast
    | InterfaceData.ObjExpr(_, bindings) -> List.tryLast bindings
    | InterfaceData.Interface(_, None) -> None

let private insertionAfterBinding
    (SynBinding(attributes = attributes; expr = expr; trivia = trivia)) =
    let leadingKeywordRange = trivia.LeadingKeyword.Range
    let startColumn =
        attributes
        |> List.tryHead
        |> Option.map (fun attributes ->
            let attributeRange = attributes.Range
            attributeRange.StartColumn)
        |> Option.defaultValue leadingKeywordRange.StartColumn
    let expressionRange = expr.Range
    { StartColumn = startColumn
      InsertAt = expressionRange.End
      InsertWith = false }

let private interfaceSyntaxAt pos = function
    | SyntaxNode.SynMemberDefn(
        SynMemberDefn.Interface(
            interfaceType = interfaceType
            withKeyword = withKeyword
            range = declarationRange)) :: _ ->
        let typeRange = interfaceType.Range
        if Range.rangeContainsPos typeRange pos then
            Some
                { StartColumn = declarationRange.StartColumn
                  WithKeyword = withKeyword
                  TypeRange = typeRange }
        else None
    | _ -> None

let private findInterfaceSyntax (parseResults: FSharpParseFileResults) pos =
    let visitor =
        { new SyntaxVisitorBase<InterfaceSyntax>() with
            member _.VisitInterfaceSynMemberDefnType(path, _visitedType) =
                interfaceSyntaxAt pos path }
    SyntaxTraversal.Traverse(pos, parseResults.ParseTree, visitor)

let private interfaceInsertion (context: InterfaceContext) =
    match tryLastBinding context.Data, context.Syntax with
    | Some binding, _ -> Some(insertionAfterBinding binding)
    | None, Some syntax ->
        match syntax.WithKeyword with
        | Some withKeyword ->
            Some
                { StartColumn = syntax.StartColumn + 4
                  InsertAt = withKeyword.End
                  InsertWith = false }
        | None ->
            let interfaceRange = context.Data.Range
            Some
                { StartColumn = syntax.StartColumn + 4
                  InsertAt = interfaceRange.End
                  InsertWith = true }
    | None, None -> None

let private tryInterfaceAtPosition (parseResults: FSharpParseFileResults) line col =
    let pos = Position.mkPos (line + 1) col
    InterfaceStubGenerator.TryFindInterfaceDeclaration pos parseResults.ParseTree
    |> Option.map (fun interfaceData ->
        let syntax = findInterfaceSyntax parseResults pos
        let entityRange = syntax |> Option.map _.TypeRange |> Option.defaultValue interfaceData.Range
        { Data = interfaceData
          Syntax = syntax
          EntityRange = entityRange })

/// The property an accessor's compiled name — `get_Value`, `set_Value` — belongs to.
let private accessorProperty (name: string) =
    [ "get_"; "set_" ]
    |> List.tryFind (fun prefix -> name.StartsWith(prefix, System.StringComparison.Ordinal))
    |> Option.map (fun prefix -> name.Substring prefix.Length)

/// The interface's own accessor slot compiled as `compiledName`.
let private isInterfaceAccessor (compiledName: string) (symbolUse: FSharpSymbolUse) =
    match symbolUse.Symbol with
    | :? FSharpMemberOrFunctionOrValue as accessor ->
        accessor.CompiledName = compiledName
        && accessor.DeclaringEntity |> Option.exists _.IsInterface
    | _ -> false

/// The signatures of the interface members this implementation already has.
///
/// The stub generator scans an accessor binding as `get_Value` and compares the
/// symbol found there with the interface's `Value: unit -> int`. At that location
/// the name resolves to the CLASS's accessor, typed `BothAccessors -> unit -> int`
/// with its instance argument, so an implemented property never matched: a
/// `with get () = ... and set v = ...` implementation was offered again, and
/// accepting it emitted a second member that does not compile (GitHub #206). The
/// interface's own slot is at the same location, typed as the interface declares
/// it; an accessor answers with that. One accessor implemented alone still leaves
/// the other half offered.
let private implementedMemberSignatures
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (displayContext: FSharpDisplayContext)
    (interfaceData: InterfaceData) =
    let getLine = FSharpLocalAnalysis.lineGetter source
    let getMemberByLocation (name: string, range: Range) =
        match accessorProperty name with
        | Some property ->
            checkResults.GetSymbolUsesAtLocation(range.EndLine, range.EndColumn, getLine range.EndLine, [ property ])
            |> List.tryFind (isInterfaceAccessor name)
        | None ->
            checkResults.GetSymbolUseAtLocation(range.EndLine, range.EndColumn, getLine range.EndLine, [ name ])
    InterfaceStubGenerator.GetImplementedMemberSignatures
        getMemberByLocation displayContext interfaceData

let private formatInterfaceStub
    (interfaceData: InterfaceData)
    (insertion: InterfaceInsertion)
    (displayContext: FSharpDisplayContext)
    implemented
    (entity: FSharpEntity) =
    // verboseMode: emit fully typed member signatures so generic interfaces keep
    // their substituted type arguments instead of collapsing to bare `arg1`.
    InterfaceStubGenerator.FormatInterface
        insertion.StartColumn 4 interfaceData.TypeParameters "_"
        "failwith \"Not implemented yet\""
        displayContext implemented entity true

/// Drop trailing spaces/tabs from one line while keeping its CR, so generated
/// stubs never carry trailing whitespace into the user's file.
let private trimLineEnd (segment: string) =
    if segment.EndsWith "\r" then
        segment.Substring(0, segment.Length - 1).TrimEnd([| ' '; '\t' |]) + "\r"
    else
        segment.TrimEnd([| ' '; '\t' |])

/// InterfaceStubGenerator indents before breaking the line, which leaves
/// trailing whitespace the repository's own `git diff --check` gate rejects.
let private trimTrailingWhitespace (text: string) =
    text.Split('\n') |> Array.map trimLineEnd |> String.concat "\n"

let private generatedInterfaceAction filePath (insertion: InterfaceInsertion) stub =
    if System.String.IsNullOrWhiteSpace stub then None
    else
        let stub = trimTrailingWhitespace stub
        let insertAt = insertion.InsertAt
        let prefix = if insertion.InsertWith then " with" else ""
        Some
            { Title = "Implement interface"
              Kind = "quickfix"
              IsPreferred = true
              Edits =
                [ { FilePath = filePath
                    StartLine = insertAt.Line - 1
                    StartCharacter = insertAt.Column
                    EndLine = insertAt.Line - 1
                    EndCharacter = insertAt.Column
                    NewText = prefix + stub } ] }

let private generateInterfaceStub
    checkResults source filePath (context: InterfaceContext) (symbolUse: FSharpSymbolUse) =
    async {
        let entity = symbolUse.Symbol :?> FSharpEntity
        if InterfaceStubGenerator.HasNoInterfaceMember entity then return None
        else
            let displayContext = symbolUse.DisplayContext
            let! implemented =
                implementedMemberSignatures checkResults source displayContext context.Data
            match interfaceInsertion context with
            | None -> return None
            | Some insertion ->
                let stub = formatInterfaceStub context.Data insertion displayContext implemented entity
                return generatedInterfaceAction filePath insertion stub
    }

let private tryResolvedInterfaceContext checkResults parseResults line col =
    tryInterfaceAtPosition parseResults line col
    |> Option.bind (fun context ->
        resolveInterfaceEntity checkResults context.EntityRange
        |> Option.map (fun symbolUse -> context, symbolUse))

/// Generate stub implementations for the unimplemented members of an interface.
let tryGenerateInterfaceStub
    (checkResults: FSharpCheckFileResults)
    (parseResults: FSharpParseFileResults)
    (source: string)
    (filePath: string)
    (line: int)
    (col: int)
    : Async<GeneratedAction option> =
    async {
        try
            match tryResolvedInterfaceContext checkResults parseResults line col with
            | None -> return None
            | Some(context, symbolUse) ->
                return! generateInterfaceStub checkResults source filePath context symbolUse
        with ex ->
            Log.Debug(ex, "[F# CodeAction] Interface stub generation failed")
            return None
    }
