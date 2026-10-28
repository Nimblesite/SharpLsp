/// F# type-informed code actions: union case stubs and record field stubs.
/// Pure generation functions — no caching or wire types. FSharpCodeFixes
/// wraps these with its caching infrastructure.
module SharpLsp.Sidecar.FSharp.FSharpCodeActions

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open Serilog

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

/// The 0-based edit replacing an FCS range (1-based lines) with `text`.
let rangeEdit (filePath: string) (r: range) (text: string) : RawEdit =
    { FilePath = filePath
      StartLine = r.StartLine - 1
      StartCharacter = r.StartColumn
      EndLine = r.EndLine - 1
      EndCharacter = r.EndColumn
      NewText = text }

/// The identifier a binding's head pattern defines: `x` in `let x = …`, `f` in
/// `let f a = …`, `Name` in `member this.Name = …`.
let rec patIdent (pat: SynPat) : Ident option =
    match pat with
    | SynPat.Named(ident = SynIdent(ident, _)) -> Some ident
    | SynPat.LongIdent(longDotId = longId) -> longId.LongIdent |> List.tryLast
    | SynPat.As(_, rhs, _) -> patIdent rhs
    | SynPat.Typed(inner, _, _) -> patIdent inner
    | SynPat.Attrib(inner, _, _) -> patIdent inner
    | SynPat.Paren(inner, _) -> patIdent inner
    | _ -> None

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

/// True when the existing arms `return` their result, as they must inside a
/// value-producing computation expression (`match!` in a `task { }`). A bare
/// expression there is a unit statement, so the stub has to `return` too or the
/// arms disagree on type (FS0193).
let private clausesReturn (clauses: SynMatchClause list) : bool =
    clauses
    |> List.exists (fun (SynMatchClause(resultExpr = body)) ->
        match body with
        | SynExpr.YieldOrReturn _ -> true
        | _ -> false)

/// Format a single union case as a match arm stub.
let private formatCaseStub (body: string) (case: FSharpUnionCase) : string =
    if case.Fields.Count = 0 then
        $"| {case.Name} -> {body}"
    elif case.Fields.Count = 1 then
        $"| {case.Name} _ -> {body}"
    else
        let args = case.Fields |> Seq.map (fun _ -> "_") |> String.concat ", "
        $"| {case.Name}({args}) -> {body}"

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
                    let caseBody =
                        if clausesReturn clauses then "return failwith \"todo\""
                        else "failwith \"todo\""
                    let stubText =
                        missing
                        |> List.map (fun c -> $"{indent}{formatCaseStub caseBody c}")
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
                    // copyInfo = None excludes `{ record with Field = x }`: a
                    // copy-and-update expression inherits every other field, so
                    // it is never missing any and must offer no generation.
                    | SynExpr.Record(copyInfo = None; recordFields = fields; range = range)
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
    // Every primitive is matched above by short name, so the fallback can use the
    // fully-qualified form: a bare `Guid` only compiles when the target file
    // happens to `open System`, which generated code must never assume.
    | _ -> $"Unchecked.defaultof<{ty.Format(FSharpDisplayContext.Empty)}>"

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
