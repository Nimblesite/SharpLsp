/// Call hierarchy and type hierarchy for the F# sidecar via FCS.
/// FCS has no built-in call graph, so callers/callees are resolved from the
/// untyped AST (SyntaxTraversal) plus project-wide symbol uses.
/// Implements [FS-CALLHIER-*] and [FS-TYPEHIER-*].
module SharpLsp.Sidecar.FSharp.FSharpHierarchy

open System.Collections.Generic
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open Serilog

/// A hierarchy item in the sidecar's neutral domain shape. The handler maps it
/// onto the wire CallHierarchyItem/TypeHierarchyItem (identical 7-field layout),
/// which the Rust host turns into LSP items. Kinds are capitalized to match the
/// host's `parse_symbol_kind`.
type HierItem =
    { Name: string
      Kind: string
      FilePath: string
      Line: int
      Character: int
      EndLine: int
      EndCharacter: int }

// ── Shared symbol → item mapping ─────────────────────────────────

/// Map an FCS symbol to a capitalized kind string the Rust host understands.
let private symbolKind (symbol: FSharpSymbol) : string =
    match symbol with
    | :? FSharpEntity as ent ->
        if ent.IsNamespace then "Namespace"
        elif ent.IsInterface then "Interface"
        elif ent.IsEnum then "Enum"
        elif ent.IsValueType then "Struct"
        elif ent.IsFSharpModule then "Module"
        else "Class"
    | :? FSharpMemberOrFunctionOrValue as mfv ->
        if mfv.IsConstructor then "Constructor"
        elif mfv.IsProperty then "Property"
        else "Function"
    | :? FSharpField -> "Field"
    | _ -> "Function"

/// Build a hierarchy item from a symbol's declaration location.
let private itemOfSymbol (symbol: FSharpSymbol) : HierItem option =
    match symbol.DeclarationLocation with
    | Some r when r.FileName <> "" ->
        Some
            { Name = symbol.DisplayName
              Kind = symbolKind symbol
              FilePath = r.FileName
              Line = r.StartLine - 1
              Character = r.StartColumn
              EndLine = r.EndLine - 1
              EndCharacter = r.EndColumn }
    | _ -> None

/// Key used to de-duplicate hierarchy items by source location.
let private itemKey (item: HierItem) : string =
    $"{item.FilePath}:{item.Line}:{item.Character}"

// ── Enclosing-declaration resolution (untyped AST) ───────────────

/// Extract the defining identifier from a binding's head pattern.
let rec private patIdent (pat: SynPat) : Ident option =
    match pat with
    | SynPat.Named(ident = SynIdent(ident, _)) -> Some ident
    | SynPat.LongIdent(longDotId = longId) -> longId.LongIdent |> List.tryLast
    | SynPat.As(_, rhs, _) -> patIdent rhs
    | SynPat.Typed(inner, _, _) -> patIdent inner
    | SynPat.Attrib(inner, _, _) -> patIdent inner
    | SynPat.Paren(inner, _) -> patIdent inner
    | _ -> None

/// Find the innermost binding/member enclosing a position, returning its name
/// identifier and whole-binding range.
let private enclosingBinding (parseTree: ParsedInput) (pos: pos) : (Ident * range) option =
    let visitor =
        { new SyntaxVisitorBase<Ident * range>() with
            member _.VisitExpr(_path, _traverse, defaultTraverse, expr) = defaultTraverse expr

            member _.VisitBinding(_path, defaultTraverse, binding) =
                match defaultTraverse binding with
                | Some inner -> Some inner
                | None ->
                    // RangeOfBindingWithRhs spans the whole binding incl. its body;
                    // the bare `range` field covers only the head (before `=`).
                    let (SynBinding(headPat = pat)) = binding
                    patIdent pat |> Option.map (fun ident -> (ident, binding.RangeOfBindingWithRhs)) }

    SyntaxTraversal.Traverse(pos, parseTree, visitor)

// ── Call hierarchy ───────────────────────────────────────────────

/// Whether a symbol represents something that can be called (function/member).
let private isCallable (symbol: FSharpSymbol) : bool =
    match symbol with
    | :? FSharpMemberOrFunctionOrValue as mfv ->
        mfv.IsMember || mfv.IsConstructor || mfv.FullType.IsFunctionType
    | _ -> false

/// Prepare a call-hierarchy item at a position.
let prepareCall (state: FSharpWorkspace.FSharpWorkspaceState) filePath line character =
    task {
        try
            let! fileCheck = FSharpWorkspace.checkFile state filePath
            match fileCheck with
            | None -> return None
            | Some(checkResults, source) ->
                match FSharpWorkspace.getSymbolUse checkResults source line character with
                | Some su -> return itemOfSymbol su.Symbol
                | None -> return None
        with ex ->
            Log.Debug(ex, "[F# PrepareCallHierarchy] failed")
            return None
    }

/// Resolve the caller (enclosing declaration) of a single call-site use.
let private callerItem (state: FSharpWorkspace.FSharpWorkspaceState) (su: FSharpSymbolUse) =
    task {
        let r = su.Range
        let! checkData = FSharpWorkspace.checkFileWithParse state r.FileName
        match checkData with
        | None -> return None
        | Some(parseResults, checkResults, source) ->
            let pos = Position.mkPos r.StartLine r.StartColumn
            match enclosingBinding parseResults.ParseTree pos with
            | None -> return None
            | Some(ident, _range) ->
                let lines = source.Split('\n')
                let idRange = ident.idRange
                let nameLine = idRange.StartLine - 1
                if nameLine < 0 || nameLine >= lines.Length then
                    return None
                else
                    let lineText = lines[nameLine]
                    let resolved =
                        checkResults.GetSymbolUseAtLocation(
                            idRange.StartLine, idRange.EndColumn, lineText, [ ident.idText ])
                    match resolved with
                    | Some caller -> return itemOfSymbol caller.Symbol
                    | None -> return None
    }

/// Get incoming calls: project-wide call sites of the symbol, mapped to the
/// declaration that encloses each call.
let incomingCalls (state: FSharpWorkspace.FSharpWorkspaceState) filePath line character =
    task {
        try
            let! uses = FSharpReferences.getProjectUsages state filePath line character
            let callSites = uses |> Array.filter (fun u -> not u.IsFromDefinition)
            let results = List<HierItem>()
            let seen = HashSet<string>()
            for su in callSites do
                let! caller = callerItem state su
                match caller with
                | Some item when seen.Add(itemKey item) -> results.Add(item)
                | _ -> ()
            return List.ofSeq results
        with ex ->
            Log.Debug(ex, "[F# IncomingCalls] failed")
            return []
    }

/// Get outgoing calls: function/member applications inside the symbol's own
/// binding body.
let outgoingCalls (state: FSharpWorkspace.FSharpWorkspaceState) filePath line character =
    task {
        try
            let! checkData = FSharpWorkspace.checkFileWithParse state filePath
            match checkData with
            | None -> return []
            | Some(parseResults, checkResults, source) ->
                match FSharpWorkspace.getSymbolUse checkResults source line character with
                | None -> return []
                | Some su ->
                    match su.Symbol.DeclarationLocation with
                    | None -> return []
                    | Some declRange ->
                        let pos = Position.mkPos declRange.StartLine declRange.StartColumn
                        match enclosingBinding parseResults.ParseTree pos with
                        | None -> return []
                        | Some(_ident, bindingRange) ->
                            let results = List<HierItem>()
                            let seen = HashSet<string>()
                            for u in checkResults.GetAllUsesOfAllSymbolsInFile() do
                                if not u.IsFromDefinition
                                   && Range.rangeContainsRange bindingRange u.Range
                                   && isCallable u.Symbol then
                                    match itemOfSymbol u.Symbol with
                                    | Some item when seen.Add(itemKey item) -> results.Add(item)
                                    | _ -> ()
                            return List.ofSeq results
        with ex ->
            Log.Debug(ex, "[F# OutgoingCalls] failed")
            return []
    }

// ── Type hierarchy ───────────────────────────────────────────────

/// Resolve the entity at a position, if the symbol there is a type/module.
let private entityAt (checkResults: FSharp.Compiler.CodeAnalysis.FSharpCheckFileResults) source line character =
    match FSharpWorkspace.getSymbolUse checkResults source line character with
    | Some su ->
        match su.Symbol with
        | :? FSharpEntity as ent -> Some ent
        | _ -> None
    | None -> None

/// Whether an entity is System.Object (the implicit base — excluded from supertypes).
let private isObjectType (entity: FSharpEntity) : bool =
    match entity.TryFullName with
    | Some name -> name = "System.Object"
    | None -> entity.DisplayName = "obj"

/// Prepare a type-hierarchy item at a position.
let prepareType (state: FSharpWorkspace.FSharpWorkspaceState) filePath line character =
    task {
        try
            let! fileCheck = FSharpWorkspace.checkFile state filePath
            match fileCheck with
            | None -> return None
            | Some(checkResults, source) ->
                match entityAt checkResults source line character with
                | Some ent -> return itemOfSymbol (ent :> FSharpSymbol)
                | None -> return None
        with ex ->
            Log.Debug(ex, "[F# PrepareTypeHierarchy] failed")
            return None
    }

/// Get supertypes: the base type (unless Object) plus declared interfaces.
let supertypes (state: FSharpWorkspace.FSharpWorkspaceState) filePath line character =
    task {
        try
            let! fileCheck = FSharpWorkspace.checkFile state filePath
            match fileCheck with
            | None -> return []
            | Some(checkResults, source) ->
                match entityAt checkResults source line character with
                | None -> return []
                | Some ent ->
                    let baseEntities =
                        match ent.BaseType with
                        | Some bt when bt.HasTypeDefinition && not (isObjectType bt.TypeDefinition) ->
                            [ bt.TypeDefinition ]
                        | _ -> []
                    let interfaces =
                        ent.DeclaredInterfaces
                        |> Seq.choose (fun ty ->
                            if ty.HasTypeDefinition then Some ty.TypeDefinition else None)
                        |> List.ofSeq
                    return
                        baseEntities @ interfaces
                        |> List.choose (fun e -> itemOfSymbol (e :> FSharpSymbol))
        with ex ->
            Log.Debug(ex, "[F# Supertypes] failed")
            return []
    }

/// Whether `candidate` directly derives from / implements `target`.
let private derivesFrom (target: FSharpEntity) (candidate: FSharpEntity) : bool =
    let matches (ty: FSharpType) =
        ty.HasTypeDefinition && target.IsEffectivelySameAs(ty.TypeDefinition :> FSharpSymbol)
    let baseMatch =
        match candidate.BaseType with
        | Some bt -> matches bt
        | None -> false
    baseMatch || (candidate.DeclaredInterfaces |> Seq.exists matches)

/// Get subtypes: project entities whose base type or interfaces include the target.
let subtypes (state: FSharpWorkspace.FSharpWorkspaceState) filePath line character =
    task {
        try
            let! fileCheck = FSharpWorkspace.checkFile state filePath
            match fileCheck with
            | None -> return []
            | Some(checkResults, source) ->
                match entityAt checkResults source line character with
                | None -> return []
                | Some target ->
                    let! proj = FSharpWorkspace.checkProject state
                    match proj with
                    | None -> return []
                    | Some projResults ->
                        let entities =
                            projResults.GetAllUsesOfAllSymbols()
                            |> Array.choose (fun u ->
                                match u.Symbol with
                                | :? FSharpEntity as ent when u.IsFromDefinition -> Some ent
                                | _ -> None)
                            |> Array.distinctBy (fun ent ->
                                ent.TryFullName |> Option.defaultValue ent.DisplayName)
                        return
                            entities
                            |> Array.filter (derivesFrom target)
                            |> Array.choose (fun ent -> itemOfSymbol (ent :> FSharpSymbol))
                            |> Array.toList
        with ex ->
            Log.Debug(ex, "[F# Subtypes] failed")
            return []
    }
