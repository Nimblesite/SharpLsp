/// F# pipe ↔ nested-call conversion code actions.
/// Implements [SHARPLSP-FEATURES-REFACTORING] — "Convert between expression
/// forms … Pipeline ↔ function composition" ([REFACTOR-FSHARP-PIPE]): rewrites
/// `x |> f |> g a` ⇄ `g a (f x)`.
///
/// Everything comes from the untyped AST (`ParsedInput` / `SynExpr`): the
/// expressions enclosing the request position are found with a syntax-tree
/// walk, and the replacement text is sliced from the source by AST ranges —
/// never by regex or string search. An action is offered only where the
/// syntax shows the rewrite keeps its meaning; anything else offers nothing.
module SharpLsp.Sidecar.FSharp.FSharpPipeRefactoring

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Syntax
open FSharp.Compiler.SyntaxTrivia
open FSharp.Compiler.Text
open SharpLsp.Sidecar.FSharp.FSharpCodeActions

/// What every rewrite at one request reads.
[<NoComparison; NoEquality>]
type private Site =
    { Line: int -> string
      Comments: range list
      FilePath: string
      Pos: pos }

// ── Source slicing ──────────────────────────────────────────────

/// Slice the source text covered by an expression's AST range (1-based
/// lines). A range spanning lines has no single-line slice, so it is
/// unavailable here.
let private slice (line: int -> string) (e: SynExpr) : string option =
    let r = e.Range
    let text = line r.StartLine

    if r.StartLine <> r.EndLine || r.StartColumn > r.EndColumn || r.EndColumn > text.Length then
        None
    else
        Some(text.Substring(r.StartColumn, r.EndColumn - r.StartColumn))

/// Every comment's range in the file.
let private commentRanges (input: ParsedInput) : range list =
    match input with
    | ParsedInput.ImplFile file ->
        file.Trivia.CodeComments
        |> List.map (function
            | CommentTrivia.LineComment r
            | CommentTrivia.BlockComment r -> r)
    | ParsedInput.SigFile _ -> []

/// A comment inside `e` would be lost: the rewrite is assembled from AST
/// slices, which hold no comments. [REFACTOR-FSHARP-PIPE]
let private hasComment (site: Site) (e: SynExpr) : bool =
    site.Comments |> List.exists (Range.rangeContainsRange e.Range)

// ── Operators and applications ──────────────────────────────────

/// True for the identifier of the operator compiled as `name` (`op_PipeRight`).
let private isOperator (name: string) (lid: SynLongIdent) : bool =
    (lid.LongIdent |> List.map _.idText) = [ name ]

/// The `left op right` operands of an infix application of operator `name`.
let private infixOperands (name: string) (e: SynExpr) : (SynExpr * SynExpr) option =
    match e with
    | SynExpr.App(
        funcExpr = SynExpr.App(isInfix = true; funcExpr = SynExpr.LongIdent(longDotId = lid); argExpr = left);
        argExpr = right) when isOperator name lid -> Some(left, right)
    | _ -> None

/// The `left |> stage` shape of an infix pipe application.
let private pipeApplication (e: SynExpr) : (SynExpr * SynExpr) option = infixOperands "op_PipeRight" e

/// Split the left-associated chain `x |> f |> g a` into head value and stages.
let rec private pipelineOf (e: SynExpr) : SynExpr * SynExpr list =
    match pipeApplication e with
    | Some(left, stage) ->
        let value, stages = pipelineOf left
        value, stages @ [ stage ]
    | None -> e, []

/// The head of an application spine: the `f` of `f a b`.
let rec private spineHead (e: SynExpr) : SynExpr =
    match e with
    | SynExpr.App(isInfix = false; funcExpr = f) -> spineHead f
    | _ -> e

/// A head F# applies only in place, never as a pipeline stage: a bare operator
/// token such as the `-` of `-x`, and the `nameof`/`reraise` intrinsics. A
/// parenthesised operator, `(+)`, is an ordinary function.
let private mustApplyInPlace (e: SynExpr) : bool =
    match e with
    | SynExpr.Ident ident -> ident.idText = "nameof" || ident.idText = "reraise"
    | SynExpr.LongIdent(longDotId = SynLongIdent(trivia = trivia)) ->
        trivia
        |> List.exists (function
            | Some(IdentTrivia.OriginalNotation _) -> true
            | _ -> false)
    | _ -> false

/// A plain prefix application `f a b` as its callee `f a` and last argument
/// `b` — never an operator use (`x + 1`, `-x`, `x |> f`).
let private plainApplication (e: SynExpr) : (SynExpr * SynExpr) option =
    match e with
    | SynExpr.App(isInfix = false; funcExpr = callee; argExpr = last) ->
        match spineHead callee with
        | SynExpr.App _ -> None
        | head when mustApplyInPlace head -> None
        | _ -> Some(callee, last)
    | _ -> None

/// A parenthesised plain application, e.g. the `(f x)` of `g a (f x)`.
let private parenApplication (e: SynExpr) : SynExpr option =
    match e with
    | SynExpr.Paren(expr = inner) when (plainApplication inner).IsSome -> Some inner
    | _ -> None

// ── Nested calls → pipeline ─────────────────────────────────────

/// A pipeline as source text: head value plus one text per stage.
[<NoComparison; NoEquality>]
type private PipelineText =
    { Value: string
      Stages: string list }

/// A string literal, parenthesised or not.
let rec private isStringLiteral (e: SynExpr) : bool =
    match e with
    | SynExpr.Const(constant = SynConst.String _)
    | SynExpr.InterpolatedString _ -> true
    | SynExpr.Paren(expr = inner) -> isStringLiteral inner
    | _ -> false

/// Values a pipeline cannot carry. A method's argument list (`M(a)`,
/// `M (a, b)`, `M(name = v)`) binds tupled, named, optional and ParamArray
/// arguments only in place; a computation-expression body is no value; and a
/// string literal, parenthesised or not, type-checks as a format string only
/// as a direct argument. [REFACTOR-FSHARP-PIPE]
let private isUnpipeable (application: SynExpr) (value: SynExpr) : bool =
    match application, value with
    | SynExpr.App(flag = ExprAtomicFlag.Atomic), SynExpr.Paren _
    | _, SynExpr.Paren(expr = SynExpr.Tuple _)
    | _, SynExpr.ComputationExpr _ -> true
    | _, SynExpr.Paren(expr = inner) when (infixOperands "op_Equality" inner).IsSome -> true
    | _ -> isStringLiteral value

/// Decompose `g a (f x)` into pipeline parts, recursing while the last
/// argument is itself a parenthesised application. [REFACTOR-FSHARP-PIPE]
let rec private nestedPipeline (line: int -> string) (e: SynExpr) : PipelineText option =
    match plainApplication e with
    | Some(_, last) when isUnpipeable e last -> None
    | Some(callee, last) ->
        match parenApplication last with
        | Some inner ->
            (nestedPipeline line inner, slice line callee)
            ||> Option.map2 (fun parts stage -> { parts with Stages = parts.Stages @ [ stage ] })
        | None ->
            (slice line callee, slice line last)
            ||> Option.map2 (fun stage value -> { Value = value; Stages = [ stage ] })
    | None -> None

// ── Pipeline → nested calls ─────────────────────────────────────

/// The nested form as text, with whether it is atomic in argument position.
[<NoComparison; NoEquality>]
type private NestedText =
    { Text: string
      IsAtomic: bool }

/// True when `e` holds a lambda. In pipeline order its parameter types flow
/// from the piped value; as a leading argument they would not (FS0072).
let rec private hasLambda (e: SynExpr) : bool =
    match e with
    | SynExpr.Lambda _
    | SynExpr.MatchLambda _
    | SynExpr.DotLambda _ -> true
    | SynExpr.Paren(expr = inner) -> hasLambda inner
    | SynExpr.App(funcExpr = f; argExpr = a) -> hasLambda f || hasLambda a
    | _ -> false

/// An expression that can sit in function position unchanged.
let private isFunctionRef (e: SynExpr) : bool =
    match e with
    | SynExpr.Ident _ | SynExpr.LongIdent _ | SynExpr.DotGet _ | SynExpr.TypeApp _ | SynExpr.Paren _ -> true
    | _ -> false

/// A stage that can safely receive the piped value as its last argument: a
/// function reference or a plain application, holding no lambda.
let private isPlaceableStage (stage: SynExpr) : bool =
    not (hasLambda stage) && ((plainApplication stage).IsSome || isFunctionRef stage)

/// The piped value as text, plus whether it is atomic — an identifier, a
/// constant, or an already-parenthesised expression. Non-atomic values are
/// parenthesised by [applyStage] when they become an argument.
let private asArgument (line: int -> string) (value: SynExpr) : NestedText option =
    let isAtomic =
        match value with
        | SynExpr.Ident _ | SynExpr.LongIdent _ | SynExpr.Const _ | SynExpr.Paren _ | SynExpr.Null _ -> true
        | _ -> false

    slice line value |> Option.map (fun text -> { Text = text; IsAtomic = isAtomic })

/// Apply one stage to the accumulated value: `stage … (value)`.
let private applyStage (line: int -> string) (stage: SynExpr) (acc: NestedText) : NestedText option =
    let argument = if acc.IsAtomic then acc.Text else $"({acc.Text})"

    slice line stage
    |> Option.map (fun part -> { Text = $"{part} {argument}"; IsAtomic = false })

/// Fold `value |> f |> g a` into nested-call text `g a (f value)`.
let private nestedCallText (line: int -> string) (value: SynExpr) (stages: SynExpr list) : string option =
    (asArgument line value, stages)
    ||> List.fold (fun acc stage -> acc |> Option.bind (applyStage line stage))
    |> Option.map _.Text

// ── Guards ──────────────────────────────────────────────────────

/// Multi-line chains are never rewritten: the reassembled one-line text could
/// not reproduce the user's layout faithfully. [REFACTOR-FSHARP-PIPE]
let private isSingleLine (e: SynExpr) : bool =
    let r = e.Range
    r.StartLine = r.EndLine

/// A binding is `let!`/`use!` when its leading keyword says so.
let private isBangBinding (binding: SynBinding) : bool =
    match binding with
    | SynBinding(trivia = { LeadingKeyword = SynLeadingKeyword.LetBang _ | SynLeadingKeyword.UseBang _ }) -> true
    | _ -> false

/// True inside the right-hand side of a computation-expression `let!`/`use!`
/// binding or a `do!` — the rewrite could change what the builder's Bind
/// sees, so nothing is offered there. [REFACTOR-FSHARP-PIPE]
let private insideBang (path: SyntaxNode list) (pos: pos) : bool =
    path
    |> List.exists (fun node ->
        match node with
        | SyntaxNode.SynExpr(SynExpr.LetOrUse letOrUse) ->
            letOrUse.Bindings
            |> List.exists (fun binding ->
                isBangBinding binding
                && (let (SynBinding(expr = rhs)) = binding in Range.rangeContainsPos rhs.Range pos))
        | SyntaxNode.SynExpr(SynExpr.DoBang(expr = rhs; range = _)) -> Range.rangeContainsPos rhs.Range pos
        | _ -> false)

/// True when rewriting `e` alone would split a larger expression: the callee
/// of an application, a pipeline stage, or a chain left of a further `|>`.
/// [REFACTOR-FSHARP-PIPE]
let private isStructural (parent: SyntaxNode option) (e: SynExpr) : bool =
    match parent with
    | Some(SyntaxNode.SynExpr(SynExpr.App(isInfix = false; funcExpr = callee) as app)) ->
        LanguagePrimitives.PhysicalEquality callee e
        || pipeApplication app
           |> Option.exists (fun (_, stage) -> LanguagePrimitives.PhysicalEquality stage e)
    | Some(SyntaxNode.SynExpr(SynExpr.App(isInfix = true; funcExpr = SynExpr.LongIdent(longDotId = lid)))) ->
        isOperator "op_PipeRight" lid && (pipeApplication e).IsSome
    | _ -> false

/// A pipeline binds looser than any operator, so one replacing an operand
/// keeps its grouping in parentheses — except at the head of a further `|>`,
/// which is left-associative: `f x |> g` simply becomes `x |> f |> g`.
/// [REFACTOR-FSHARP-PIPE]
let private grouped (parent: SyntaxNode option) (text: string) : string =
    match parent with
    | Some(SyntaxNode.SynExpr(SynExpr.App(isInfix = true; funcExpr = SynExpr.LongIdent(longDotId = lid)))) when
        isOperator "op_PipeRight" lid
        ->
        text
    | Some(SyntaxNode.SynExpr(SynExpr.App _)) -> $"({text})"
    | _ -> text

// ── Actions ─────────────────────────────────────────────────────

/// The single-edit refactoring action replacing `r` with `text`.
let private convertAction (title: string) (filePath: string) (r: range) (text: string) : GeneratedAction =
    { Title = title
      Kind = "refactor"
      IsPreferred = false
      Edits = [ rangeEdit filePath r text ] }

/// "Convert pipeline to nested calls" for the chain at `e`. [REFACTOR-FSHARP-PIPE]
let private nestedCallsAction (site: Site) (e: SynExpr) : GeneratedAction option =
    match pipelineOf e with
    | value, stages when not stages.IsEmpty && List.forall isPlaceableStage stages ->
        nestedCallText site.Line value stages
        |> Option.map (convertAction "Convert pipeline to nested calls" site.FilePath e.Range)
    | _ -> None

/// "Convert nested calls to pipeline" for the application at `e`. [REFACTOR-FSHARP-PIPE]
let private pipelineAction (site: Site) (parent: SyntaxNode option) (e: SynExpr) : GeneratedAction option =
    nestedPipeline site.Line e
    |> Option.map (fun parts ->
        parts.Value :: parts.Stages
        |> String.concat " |> "
        |> grouped parent
        |> convertAction "Convert nested calls to pipeline" site.FilePath e.Range)

// ── Traversal ───────────────────────────────────────────────────

/// The conversion `e` itself offers: none when it misses the cursor, is
/// structural, spans lines or holds a comment.
let private actionsHere (site: Site) (parent: SyntaxNode option) (e: SynExpr) : GeneratedAction list =
    if
        not (Range.rangeContainsPos e.Range site.Pos)
        || isStructural parent e
        || not (isSingleLine e)
        || hasComment site e
    then
        []
    elif (pipeApplication e).IsSome then
        Option.toList (nestedCallsAction site e)
    else
        Option.toList (pipelineAction site parent e)

/// This level's actions first, then deeper ones under titles not yet offered:
/// the outermost conversion of each kind wins.
let private outermostFirst (here: GeneratedAction list) (deeper: GeneratedAction list) : GeneratedAction list =
    here @ (deeper |> List.filter (fun d -> here |> List.forall (fun h -> h.Title <> d.Title)))

/// Actions for every expression enclosing the cursor. A chain that cannot
/// convert — a lambda stage, several lines, a comment — still lets the
/// expressions inside its stages convert, but never its stages or sub-chains
/// alone, so no partial rewrite is offered.
let private actionsFor
    (site: Site)
    (path: SyntaxNode list)
    (e: SynExpr)
    (defaultTraverse: SynExpr -> GeneratedAction list option)
    : GeneratedAction list option =
    if insideBang path site.Pos then
        Some []
    else
        let deeper = defaultTraverse e |> Option.defaultValue []
        Some(outermostFirst (actionsHere site (List.tryHead path) e) deeper)

/// The pipe conversion actions offered at a request position (0-based line).
/// Implements [SHARPLSP-FEATURES-REFACTORING] / [REFACTOR-FSHARP-PIPE].
let tryGenerateActions
    (parseResults: FSharpParseFileResults)
    (source: string)
    (filePath: string)
    (line: int)
    (col: int)
    : GeneratedAction list =
    let site =
        { Line = FSharpLocalAnalysis.lineGetter source
          Comments = commentRanges parseResults.ParseTree
          FilePath = filePath
          Pos = Position.mkPos (line + 1) col }

    let visitor =
        { new SyntaxVisitorBase<GeneratedAction list>() with
            member _.VisitExpr(path, _traverse, defaultTraverse, expr) = actionsFor site path expr defaultTraverse }

    SyntaxTraversal.Traverse(site.Pos, parseResults.ParseTree, visitor)
    |> Option.defaultValue []
