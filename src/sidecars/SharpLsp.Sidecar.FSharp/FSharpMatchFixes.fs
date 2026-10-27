/// F# quick fix that completes a match FCS reports incomplete (FS0025). The
/// wildcard case goes after the reported match's own last clause, lined up
/// with that clause's bar, both found in the untyped AST — never by scanning
/// lines, which mistook an enclosing match's cases for the inner match's.
/// Implements [ANALYZERS-FSAC-CODEFIX-COMPILER].
module SharpLsp.Sidecar.FSharp.FSharpMatchFixes

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open FSharp.Compiler.Syntax
open FSharp.Compiler.SyntaxTrivia
open FSharp.Compiler.Text
open SharpLsp.Sidecar.FSharp.FSharpCodeActions

/// The case added to complete a match.
let private WILDCARD = "| _ -> failwith \"Unhandled case\""

/// The clauses of the innermost `match`, `match!` or `function` holding `pos`.
let private clausesAt (parseResults: FSharpParseFileResults) (pos: pos) : SynMatchClause list option =
    let visitor =
        { new SyntaxVisitorBase<SynMatchClause list>() with
            member _.VisitExpr(_, _, defaultTraverse, expr) =
                match expr with
                | SynExpr.Match(clauses = clauses)
                | SynExpr.MatchBang(clauses = clauses)
                | SynExpr.MatchLambda(matchClauses = clauses) ->
                    defaultTraverse expr |> Option.orElse (Some clauses)
                | _ -> defaultTraverse expr }

    SyntaxTraversal.Traverse(pos, parseResults.ParseTree, visitor)

/// The column a new clause lines up at: the clause's bar, or its pattern when
/// the clause has none (a first clause may omit it).
let private clauseColumn (clause: SynMatchClause) : int =
    match clause with
    | SynMatchClause(trivia = { BarRange = Some bar }) -> bar.StartColumn
    | SynMatchClause(pat = pattern) ->
        let start = pattern.Range
        start.StartColumn

/// "Add wildcard case" on the line after the reported match's last clause.
let wildcards (parseResults: FSharpParseFileResults) filePath (r: range) : GeneratedAction list =
    clausesAt parseResults r.Start
    |> Option.bind List.tryLast
    |> Option.map (fun last ->
        let clause = last.Range
        let after = Position.mkPos (clause.EndLine + 1) (clauseColumn last)
        FSharpQuickFix.insertLine "Add wildcard case '| _ ->'" filePath after WILDCARD)
    |> Option.toList
