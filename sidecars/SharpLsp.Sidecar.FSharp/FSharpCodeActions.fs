/// F# type-informed code actions: union case stubs and record field stubs.
/// Pure generation functions — no caching or wire types. FSharpCodeFixes
/// wraps these with its caching infrastructure.
module SharpLsp.Sidecar.FSharp.FSharpCodeActions

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text

/// A raw text edit (no MessagePack annotations — internal use only).
type RawEdit =
    { FilePath: string
      StartLine: int
      StartCharacter: int
      EndLine: int
      EndCharacter: int
      NewText: string }

/// A generated code action with title and edits.
type GeneratedAction =
    { Title: string
      Kind: string
      IsPreferred: bool
      Edits: RawEdit list }

// ── Union case stub generation ──────────────────────────────────

/// Walk the parse tree to find match clauses covering a position.
let private findMatchClauses
    (parseResults: FSharpParseFileResults)
    (line: int)
    (col: int)
    : SynMatchClause list option =
    try
        let pos = Position.mkPos (line + 1) col
        let visitor =
            { new SyntaxVisitorBase<SynMatchClause list>() with
                member _.VisitExpr(_path, _traverse, defaultTraverse, expr) =
                    match expr with
                    | SynExpr.Match(clauses = clauses; range = range)
                    | SynExpr.MatchBang(clauses = clauses; range = range)
                        when Range.rangeContainsPos range pos ->
                        Some clauses
                    | _ -> defaultTraverse expr }
        SyntaxTraversal.Traverse(pos, parseResults.ParseTree, visitor)
    with _ -> None

/// Extract case names already present in match clauses.
let private existingCaseNames (clauses: SynMatchClause list) : Set<string> =
    clauses
    |> List.choose (fun (SynMatchClause(pat = pat)) ->
        match pat with
        | SynPat.LongIdent(longDotId = longId) ->
            longId.LongIdent |> List.tryLast |> Option.map (fun i -> i.idText)
        | _ -> None)
    |> Set.ofList

/// Format a single union case as a match arm stub.
let private formatCaseStub (case: FSharpUnionCase) : string =
    if case.Fields.Count = 0 then
        $"| {case.Name} -> failwith \"todo\""
    elif case.Fields.Count = 1 then
        $"| {case.Name} _ -> failwith \"todo\""
    else
        let args = case.Fields |> Seq.map (fun _ -> "_") |> String.concat ", "
        $"| {case.Name}({args}) -> failwith \"todo\""

/// Try to resolve the DU type from the match expression's subject.
let private resolveMatchType
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (clauses: SynMatchClause list)
    : FSharpEntity option =
    // Look at existing case patterns to find the DU entity.
    let uses = checkResults.GetAllUsesOfAllSymbolsInFile() |> Seq.toArray
    clauses
    |> List.tryPick (fun (SynMatchClause(pat = pat)) ->
        match pat with
        | SynPat.LongIdent(longDotId = longId; range = range) ->
            uses
            |> Array.tryPick (fun su ->
                let suRange = su.Range
                if suRange.StartLine = range.StartLine
                   && suRange.StartColumn = range.StartColumn then
                    match su.Symbol with
                    | :? FSharpUnionCase as uc ->
                        let retTy = uc.ReturnType
                        if retTy.HasTypeDefinition && retTy.TypeDefinition.IsFSharpUnion then
                            Some retTy.TypeDefinition
                        else None
                    | _ -> None
                else None)
        | _ -> None)

/// Generate union case stubs for an incomplete match expression.
let tryGenerateUnionStubs
    (checkResults: FSharpCheckFileResults)
    (parseResults: FSharpParseFileResults)
    (source: string)
    (filePath: string)
    (line: int)
    (col: int)
    : GeneratedAction option =
    try
        match findMatchClauses parseResults line col with
        | None -> None
        | Some clauses when clauses.IsEmpty -> None
        | Some clauses ->
            let existing = existingCaseNames clauses
            match resolveMatchType checkResults source clauses with
            | None -> None
            | Some entity ->
                let missing =
                    entity.UnionCases
                    |> Seq.filter (fun c -> not (existing.Contains c.Name))
                    |> Seq.toList
                if missing.IsEmpty then None
                else
                    let lastClause = clauses |> List.last
                    let lastRange = lastClause.Range
                    let insertLine = lastRange.EndLine - 1
                    let lines = source.Split('\n')
                    let indent =
                        if insertLine < lines.Length then
                            let ln = lines[insertLine]
                            let pipeIdx = ln.IndexOf('|')
                            if pipeIdx >= 0 then String.replicate pipeIdx " "
                            else "    "
                        else "    "
                    let stubText =
                        missing
                        |> List.map (fun c -> $"{indent}{formatCaseStub c}")
                        |> String.concat "\n"
                    Some
                        { Title = $"Generate {missing.Length} missing union case(s)"
                          Kind = "quickfix"
                          IsPreferred = true
                          Edits =
                            [ { FilePath = filePath
                                StartLine = insertLine + 1
                                StartCharacter = 0
                                EndLine = insertLine + 1
                                EndCharacter = 0
                                NewText = $"{stubText}\n" } ] }
    with _ -> None

// ── Record field stub generation ────────────────────────────────

/// Walk the parse tree to find a record expression at a position.
let private findRecordExpr
    (parseResults: FSharpParseFileResults)
    (line: int)
    (col: int)
    : (SynExprRecordField list * Range) option =
    try
        let pos = Position.mkPos (line + 1) col
        let visitor =
            { new SyntaxVisitorBase<SynExprRecordField list * Range>() with
                member _.VisitExpr(_path, _traverse, defaultTraverse, expr) =
                    match expr with
                    | SynExpr.Record(recordFields = fields; range = range)
                        when Range.rangeContainsPos range pos ->
                        Some(fields, range)
                    | _ -> defaultTraverse expr }
        SyntaxTraversal.Traverse(pos, parseResults.ParseTree, visitor)
    with _ -> None

/// Extract existing field names from record expression fields.
let private existingFieldNames (fields: SynExprRecordField list) : Set<string> =
    fields
    |> List.choose (fun (SynExprRecordField(fieldName = (longId, _))) ->
        longId.LongIdent |> List.tryLast |> Option.map (fun i -> i.idText))
    |> Set.ofList

/// Generate a default value for a given F# type.
let private defaultValue (ty: FSharpType) : string =
    // Use the SHORT type name: FSharpDisplayContext.Empty fully-qualifies every
    // name (e.g. "Microsoft.FSharp.Core.int"), which would never match the bare
    // literals below. The type definition's DisplayName gives "int"/"bool"/
    // "option"/"list"/"array" directly, and short names are correct for stub text
    // inserted where the type is already in scope.
    let name =
        if ty.HasTypeDefinition then ty.TypeDefinition.DisplayName
        else ty.Format(FSharpDisplayContext.Empty)
    match name with
    | "string" -> "\"\""
    | "int" | "int32" | "int64" | "float" | "double" | "decimal" -> "0"
    | "bool" -> "false"
    | _ when name.StartsWith("option") -> "None"
    | _ when name.StartsWith("list") -> "[]"
    | _ when name.StartsWith("array") -> "[||]"
    | _ -> $"Unchecked.defaultof<{name}>"

/// Resolve record entity from symbol uses at the record expression.
let private resolveRecordType
    (checkResults: FSharpCheckFileResults)
    (range: Range)
    : FSharpEntity option =
    let uses = checkResults.GetAllUsesOfAllSymbolsInFile() |> Seq.toArray
    uses
    |> Array.tryPick (fun su ->
        let suRange = su.Range
        if suRange.StartLine >= range.StartLine
           && suRange.EndLine <= range.EndLine then
            match su.Symbol with
            | :? FSharpField as field ->
                let declEntity = field.DeclaringEntity
                match declEntity with
                | Some ent when ent.IsFSharpRecord -> Some ent
                | _ -> None
            | _ -> None
        else None)

/// Generate record field stubs for an incomplete record expression.
let tryGenerateRecordStubs
    (checkResults: FSharpCheckFileResults)
    (parseResults: FSharpParseFileResults)
    (_source: string)
    (filePath: string)
    (line: int)
    (col: int)
    : GeneratedAction option =
    try
        match findRecordExpr parseResults line col with
        | None -> None
        | Some(fields, range) ->
            let existing = existingFieldNames fields
            match resolveRecordType checkResults range with
            | None -> None
            | Some entity ->
                let missing =
                    entity.FSharpFields
                    |> Seq.filter (fun f -> not (existing.Contains f.Name))
                    |> Seq.toList
                if missing.IsEmpty then None
                else
                    let stubText =
                        missing
                        |> List.map (fun f -> $"{f.Name} = {defaultValue f.FieldType}")
                        |> String.concat "; "
                    let insertLine = range.EndLine - 1
                    let insertCol = range.EndColumn - 1
                    Some
                        { Title = $"Generate {missing.Length} missing record field(s)"
                          Kind = "quickfix"
                          IsPreferred = true
                          Edits =
                            [ { FilePath = filePath
                                StartLine = insertLine
                                StartCharacter = max 0 insertCol
                                EndLine = insertLine
                                EndCharacter = max 0 insertCol
                                NewText = $"; {stubText}" } ] }
    with _ -> None

// ── Interface implementation stub generation ────────────────────
// [FS-CODEFIX-INTERFACESTUB] Completes the stub-generation trio (union / record /
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
    |> Seq.tryPick (fun su ->
        match su.Symbol with
        | :? FSharpEntity as ent when
            InterfaceStubGenerator.IsInterface ent
            && Range.rangeContainsRange interfaceRange su.Range -> Some su
        | _ -> None)

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
            let pos = Position.mkPos (line + 1) col

            match InterfaceStubGenerator.TryFindInterfaceDeclaration pos parseResults.ParseTree with
            | None -> return None
            | Some interfaceData ->
                // Bind the struct range to a local so property access doesn't trip FS0052.
                let interfaceRange = interfaceData.Range

                match resolveInterfaceEntity checkResults interfaceRange with
                | None -> return None
                | Some symbolUse ->
                    let entity = symbolUse.Symbol :?> FSharpEntity

                    if InterfaceStubGenerator.HasNoInterfaceMember entity then
                        return None
                    else
                        let getLine = FSharpLocalAnalysis.lineGetter source

                        let getMemberByLocation (name: string, range: Range) =
                            checkResults.GetSymbolUseAtLocation(
                                range.EndLine, range.EndColumn, getLine range.EndLine, [ name ])

                        let displayContext = symbolUse.DisplayContext

                        let! implemented =
                            InterfaceStubGenerator.GetImplementedMemberSignatures
                                getMemberByLocation displayContext interfaceData

                        let stubIndent = interfaceRange.StartColumn + 4

                        let stub =
                            InterfaceStubGenerator.FormatInterface
                                stubIndent 4 [||] "_"
                                "failwith \"Not implemented yet\""
                                displayContext implemented entity false

                        if System.String.IsNullOrWhiteSpace stub then
                            return None
                        else
                            let insertLine = interfaceRange.EndLine - 1
                            let insertCol = interfaceRange.EndColumn
                            // Prefix `with` only when the declaration lacks it.
                            let declText = getLine interfaceRange.EndLine
                            let prefix = if declText.Contains(" with") then "\n" else " with\n"

                            return
                                Some
                                    { Title = "Implement interface"
                                      Kind = "quickfix"
                                      IsPreferred = true
                                      Edits =
                                        [ { FilePath = filePath
                                            StartLine = insertLine
                                            StartCharacter = insertCol
                                            EndLine = insertLine
                                            EndCharacter = insertCol
                                            NewText = prefix + stub } ] }
        with _ ->
            return None
    }
