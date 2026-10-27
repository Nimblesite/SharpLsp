/// AST-based compatibility rewrite of the upstream NamingHelper.fs.
///
/// The current FSharp.Compiler.Service exposes FSharpType.BasicQualifiedName as
/// a string option, while the pinned upstream source matches it against bare
/// strings. This module parses the file with Fantomas (Fantomas.FCS AST),
/// wraps exactly the two non-wildcard patterns of the single target
/// `match fSharpType.BasicQualifiedName with ...` in `Some`, and re-formats
/// the file with Fantomas. No string/regex/source-string rewriting happens.
///
/// Everything fails closed: exactly one target match and exactly two wrapped
/// patterns are required, the wild clause must remain untouched, and the
/// formatted output is re-parsed and re-verified before it is accepted.
module LintSourceBuild.AstRewrite

open System
open System.IO
open Fantomas.Core
open Fantomas.FCS.Syntax
open Fantomas.FCS.Text
open LintSourceBuild.SourcePaths

let private AsyncName = "Microsoft.FSharp.Control.FSharpAsync`1"
let private TaskPrefix = "System.Threading.Tasks.Task"
let private ScrutineeVar = "fSharpType"
let private ScrutineeProp = "BasicQualifiedName"
let private GuardMethod = "StartsWith"

// --- shape recognizers ------------------------------------------------------

let private lastIdentText (li: Ident list) : string option =
    li |> List.tryLast |> Option.map (fun i -> i.idText)

/// True for the identifier chain `a.b` used as the scrutinee: FCS parses a
/// simple dotted access as SynExpr.LongIdent [a; b]; DotGet appears when the
/// left side is a non-identifier expression. Both shapes are accepted, with
/// exact two-identifier chains only.
let private isTwoIdentAccess (left: string) (right: string) (idents: Ident list) : bool =
    match idents with
    | [first; second] -> first.idText = left && second.idText = right
    | _ -> false

let private isMemberAccess receiver memberName (e: SynExpr) =
    match e with
    | SynExpr.LongIdent(_, SynLongIdent(li, _, _), _, _) when
        isTwoIdentAccess receiver memberName li -> true
    | SynExpr.DotGet(SynExpr.Ident id, _, SynLongIdent(li, _, _), _) when
        id.idText = receiver && lastIdentText li = Some memberName -> true
    | _ -> false

let private (|TargetScrutinee|_|) expression =
    if isMemberAccess ScrutineeVar ScrutineeProp expression then Some () else None

/// `name.StartsWith "System.Threading.Tasks.Task..."` guard expression.
let private (|StartsWithGuard|_|) (patName: string) (e: SynExpr) =
    match e with
    | SynExpr.App(_, _, funcExpr, SynExpr.Const(SynConst.String(s, _, _), _), _) when
        isMemberAccess patName GuardMethod funcExpr && s.StartsWith(TaskPrefix, StringComparison.Ordinal) ->
        Some()
    | _ -> None

type private ClauseKind =
    | AsyncStringClause
    | NamedWithStartsWithGuard
    | WildClause
    | OtherClause

let private isStartsWithGuardOn (patName: string) (g: SynExpr) : bool =
    match g with
    | StartsWithGuard patName -> true
    | _ -> false

let private classifyClause (c: SynMatchClause) : ClauseKind =
    match c with
    | SynMatchClause(SynPat.Const(SynConst.String(s, _, _), _), None, _, _, _, _) when s = AsyncName ->
        AsyncStringClause
    | SynMatchClause(SynPat.Named(SynIdent(id, _), false, None, _), Some g, _, _, _, _) when
        isStartsWithGuardOn id.idText g ->
        NamedWithStartsWithGuard
    | SynMatchClause(SynPat.Wild _, None, _, _, _, _) -> WildClause
    | _ -> OtherClause

// --- the rewrite itself -----------------------------------------------------

let private wrapInSome (p: SynPat) : SynPat =
    let someLongIdent = SynLongIdent([ Ident("Some", Range.range0) ], [], [])
    SynPat.LongIdent(someLongIdent, None, None, SynArgPats.Pats [ p ], None, Range.range0)

let private wrapClause (c: SynMatchClause) : SynMatchClause =
    match c with
    | SynMatchClause(p, w, b, m, dp, trivia) -> SynMatchClause(wrapInSome p, w, b, m, dp, trivia)

/// Wrap the two non-wildcard clause patterns in Some; the wild clause is
/// passed through unchanged. Any other clause shape fails closed.
let private wrapClauses (clauses: SynMatchClause list) : Result<SynMatchClause list, PrepError> =
    match clauses |> List.map classifyClause with
    | [ AsyncStringClause; NamedWithStartsWithGuard; WildClause ] ->
        Ok [ wrapClause clauses.[0]; wrapClause clauses.[1]; clauses.[2] ]
    | shapes ->
        let described = shapes |> List.map (fun s -> string s) |> String.concat "; "
        Error(err "unexpected-match-shape" ("target match clause shape changed: " + described))

// --- generic guarded AST traversal ------------------------------------------
// Rebuilds only Fantomas.FCS.Syntax / SyntaxTrivia unions, F# lists, options,
// tuples and arrays. Everything else (ranges, strings, Ident objects, trivia
// record classes, ...) is an opaque leaf, so unrelated compiler data can
// never be rewired. A rewritten node's children are not revisited, so the
// transform cannot loop or double-apply.

open Microsoft.FSharp.Reflection

type private WalkState =
    { mutable Targets: int
      mutable Edits: int
      mutable Failure: PrepError option }

/// Hook invoked at every SynExpr node; Some e replaces the node wholesale.
type private ExprHook = WalkState -> SynExpr -> SynExpr option

let private rewritableNamespace (t: Type) =
    t.Namespace = "Fantomas.FCS.Syntax" || t.Namespace = "Fantomas.FCS.SyntaxTrivia"

let private hasGenericDefinition expected (actual: Type) =
    actual.IsGenericType && actual.GetGenericTypeDefinition() = expected

let rec private walkList hook state (x: obj) : objnull =
    let t = x.GetType()
    let cases = FSharpType.GetUnionCases(t, true)
    let rec loop items =
        match items with
        | [] -> FSharpValue.MakeUnion(cases.[0], [||], true)
        | h :: rest -> FSharpValue.MakeUnion(cases.[1], [| walk hook state h; box (loop rest) |], true)
    let rec toList o acc =
        let _, f = FSharpValue.GetUnionFields(o, t, true)
        if f.Length = 0 then List.rev acc else toList f.[1] (f.[0] :: acc)
    box (loop (toList x []))

and private walkOption hook state (x: obj) : objnull =
    let t = x.GetType()
    let _, fields = FSharpValue.GetUnionFields(x, t, true)
    if fields.Length = 0 then x
    else FSharpValue.MakeUnion((FSharpType.GetUnionCases(t, true)).[1], [| walk hook state fields.[0] |], true)

and private walkUnion hook state t (x: obj) : objnull =
    let case, fields = FSharpValue.GetUnionFields(x, t, true)
    FSharpValue.MakeUnion(case, fields |> Array.map (walk hook state), true)

and private walk hook state (x: objnull) : objnull =
    // Fantomas.FCS union values expose their per-case nested class through
    // GetType(), so SynExpr nodes must be detected with a type test, not
    // type equality.
    match x with
    | null -> null
    | :? SynExpr as e ->
        match hook state e with
        | Some rewritten -> box rewritten
        | None -> walkUnion hook state (e.GetType()) e
    | value -> walkOther hook state value

and private walkOther hook state (x: obj) : objnull =
    let t = x.GetType()
    if FSharpType.IsTuple(t) then
        FSharpValue.MakeTuple(FSharpValue.GetTupleFields(x) |> Array.map (walk hook state), t)
    elif hasGenericDefinition typedefof<obj list> t then walkList hook state x
    elif hasGenericDefinition typedefof<obj option> t then walkOption hook state x
    elif t.IsArray then box (Array.map (walk hook state) (x :?> objnull[]))
    elif FSharpType.IsUnion(t, true) && rewritableNamespace t then walkUnion hook state t x
    else x

// --- hooks -------------------------------------------------------------------

/// Rewrite hook: transforms the single target Match and records counters.
let private rewriteHook (state: WalkState) (e: SynExpr) : SynExpr option =
    match e with
    | SynExpr.Match(dp, (TargetScrutinee as scrutinee), clauses, m, trivia) ->
        state.Targets <- state.Targets + 1
        if state.Failure.IsNone then
            match wrapClauses clauses with
            | Ok wrapped ->
                state.Edits <- state.Edits + 2
                Some(SynExpr.Match(dp, scrutinee, wrapped, m, trivia))
            | Error failure ->
                state.Failure <- Some failure
                None
        else None
    | _ -> None

let private isSomeWrapped (p: SynPat) : bool =
    match p with
    | SynPat.LongIdent(SynLongIdent([ id ], _, _), _, _, SynArgPats.Pats _, _, _) -> id.idText = "Some"
    | _ -> false

/// A verified target: one BasicQualifiedName match whose first two clause
/// patterns are Some-wrapped and whose third clause is still a wild pattern.
let private isVerifiedTarget (e: SynExpr) : bool =
    match e with
    | SynExpr.Match(_, TargetScrutinee, clauses, _, _) ->
        match clauses with
        | [ SynMatchClause(p1, _, _, _, _, _)
            SynMatchClause(p2, _, _, _, _, _)
            SynMatchClause(SynPat.Wild _, _, _, _, _, _) ] ->
            isSomeWrapped p1 && isSomeWrapped p2
        | _ -> false
    | _ -> false

/// Verify hook: counts verified targets, never rewrites.
let private verifyHook (state: WalkState) (e: SynExpr) : SynExpr option =
    if isVerifiedTarget e then state.Targets <- state.Targets + 1
    None

// --- top level ---------------------------------------------------------------

let private parse (source: string) : Result<ParsedInput, PrepError> =
    try
        match CodeFormatter.ParseAsync(false, source) |> Async.RunSynchronously with
        | [||] -> Error(err "parse-failed" "parser returned no input")
        | results -> Ok(fst results.[0])
    with e ->
        Error(err "parse-failed" ("failed to parse file: " + e.Message))

let private format (ast: ParsedInput) (source: string) : Result<string, PrepError> =
    try
        Ok(CodeFormatter.FormatASTAsync(ast, source) |> Async.RunSynchronously)
    with e ->
        Error(err "format-failed" ("AST formatting failed: " + e.Message))

let private transform hook expectedEdits (ast: ParsedInput) : Result<ParsedInput, PrepError> =
    let state = { Targets = 0; Edits = 0; Failure = None }
    let result = walk hook state (box ast)
    match state.Failure with
    | Some failure -> Error failure
    | None when state.Targets <> 1 ->
        Error(err "target-count" (sprintf "expected exactly 1 target match, found %d" state.Targets))
    | None when state.Edits <> expectedEdits ->
        Error(err "edit-count" (sprintf "expected %d AST edits, found %d" expectedEdits state.Edits))
    | None ->
        match result with
        | :? ParsedInput as parsed -> Ok parsed
        | _ -> Error(err "invalid-ast" "The rewritten tree is not a parsed F# input.")

let private verify hook (formatted: string) : Result<unit, PrepError> =
    parse formatted
    |> Result.bind (fun reAst ->
        let state = { Targets = 0; Edits = 0; Failure = None }
        walk hook state (box reAst) |> ignore
        if state.Targets = 1 then Ok()
        else Error(err "verify-failed" (sprintf "expected 1 verified target after rewrite, found %d" state.Targets)))

/// Rewrite the file in place; fails closed on any deviation.
let private rewriteWith hook verification expectedEdits path =
    try
        let source = File.ReadAllText(path)
        parse source
        |> Result.bind (transform hook expectedEdits)
        |> Result.bind (fun rewritten -> format rewritten source)
        |> Result.bind (fun formatted -> verify verification formatted |> Result.map (fun () -> formatted))
        |> Result.map (fun formatted -> File.WriteAllText(path, formatted))
    with error -> Error(err "rewrite-failed" (error.GetType().Name))

let rewriteFile path = rewriteWith rewriteHook verifyHook 2 path

/// Only the cleanup match calls Clear; the rule's other stack match returns the stack.
let private clearsStack = function
    | SynExpr.App(_, _, SynExpr.LongIdent(_, SynLongIdent([_; methodName], _, _), _, _), SynExpr.Const(SynConst.Unit, _), _) ->
        methodName.idText = "Clear"
    | _ -> false

/// A completed run must release the threshold captured by its binding stack (#469).
let private resetHook state = function
    | SynExpr.Match(_, SynExpr.Ident stack,
        [SynMatchClause(_, None, clear, _, _, _); SynMatchClause(_, None, SynExpr.Const(SynConst.Unit, _), _, _, _)], range, _)
        when stack.idText = "bindingStackOpt" && clearsStack clear ->
        state.Targets <- state.Targets + 1
        state.Edits <- state.Edits + 1
        let target = SynLongIdent([Ident("bindingStackOpt", Range.range0)], [], [])
        Some(SynExpr.LongIdentSet(target, SynExpr.Ident(Ident("None", Range.range0)), range))
    | _ -> None

let private isNone = function
    | SynExpr.Ident name -> name.idText = "None"
    | SynExpr.LongIdent(_, SynLongIdent([name], _, _), _, _) -> name.idText = "None"
    | _ -> false

let private resetVerified state = function
    | SynExpr.LongIdentSet(SynLongIdent([name], _, _), value, _) when name.idText = "bindingStackOpt" && isNone value ->
        state.Targets <- state.Targets + 1
        None
    | _ -> None

let rewriteRuleState path = rewriteWith resetHook resetVerified 1 path
