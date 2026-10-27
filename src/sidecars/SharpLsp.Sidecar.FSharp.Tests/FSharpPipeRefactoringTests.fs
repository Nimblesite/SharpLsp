/// F# pipeline ↔ nested-call code actions driven through the real code-action
/// pipeline (FSharpCodeFixes.getCodeActions → resolve → apply) over a real
/// parsed .fsproj fixture. Implements [SHARPLSP-FEATURES-REFACTORING] /
/// [REFACTOR-FSHARP-PIPE].
module SharpLsp.Sidecar.FSharp.Tests.FSharpPipeRefactoringTests

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open FSharp.Compiler.Text
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

//  0: module PipeFix                       12: let n1 = f v
//  2: let v = 5                            13: let n2 = g 1 (f v)
//  3: let f (x: int) = x + 1               14: let n3 = h 2 (g 1 (f (v + 1)))
//  4: let g (a: int) (x: int) = a + x      15: let lambdaStage = v |> f |> fun x -> g x
//  5: let h (c: int) (x: int) (y: int)     16: let outside = lift v |> id
//    = c + x + y                           17: let plain = 21
//  6: let w (k: int) = k * 2               18: let multi =
//  7: let lift (x: int) = async.Return x   19:     v
//  9: let p1 = v |> f                      20:     |> f
// 10: let p2 = v |> f |> g 1               21:     |> g 1
// 11: let p3 = w v |> f                    22: let ce () =
//                                          23:     async {
//                                          24:         let! r = lift v |> id
//                                          25:         return r
//                                          26:     }
// 27: let inBody () =                      30: let nestedInBody () =
// 28:     let total = v |> f |> g 1        31:     let total = g 1 (f v)
// 29:     total                            32:     total
// 33: let operand = 1 + g 1 (f v)
// 34: let scaled = g 1 (f v) * 2
// 35: let lens = [ "a"; "bb" ] |> List.map (fun s -> s.Length)
// 36: let joined = System.String.Join(",", "a", "b")
// 37: let named () = System.Console.WriteLine(value = 1)
// 38: let commented = v |> (* keep *) f
// 39: let callee = g 1 (* keep *) (f v)
// 40: let job = async { return 1 }
// 41: let banner () = printfn "hi"
// 42: let inLambda = [ v ] |> List.map (fun x -> g 1 (f x))
// 43: let multiLambda () =
// 44:     [ v ]
// 45:     |> List.map (fun x -> g 1 (f x))
// 46: let negated = -v
// 47: let fns = [| f |]
// 48: let byIndex = v |> fns.[0]
// 49: let doBang () =
// 50:     async {
// 51:         do! lift v |> Async.Ignore
// 52:     }
// 53: let headCall = f v |> g 1
// 54: let label = nameof v
// 55: let rethrow () =
// 56:     try 1
// 57:     with _ -> reraise ()
// 58: let negLiteral = -1 |> f
// 59: type Adder() =
// 60:     member _.Sum (a: int) (b: int) = a + b
// 61: let adder = Adder()
// 62: let summed = adder.Sum 1 (f v)
// 63: let bannerParen () = printfn ("hi")
// 64: let typed = id<int> (f v)
let private PIPE_SOURCE =
    source
        [ "module PipeFix"
          ""
          "let v = 5"
          "let f (x: int) = x + 1"
          "let g (a: int) (x: int) = a + x"
          "let h (c: int) (x: int) (y: int) = c + x + y"
          "let w (k: int) = k * 2"
          "let lift (x: int) = async.Return x"
          ""
          "let p1 = v |> f"
          "let p2 = v |> f |> g 1"
          "let p3 = w v |> f"
          "let n1 = f v"
          "let n2 = g 1 (f v)"
          "let n3 = h 2 (g 1 (f (v + 1)))"
          "let lambdaStage = v |> f |> fun x -> g x"
          "let outside = lift v |> id"
          "let plain = 21"
          "let multi ="
          "    v"
          "    |> f"
          "    |> g 1"
          "let ce () ="
          "    async {"
          "        let! r = lift v |> id"
          "        return r"
          "    }"
          "let inBody () ="
          "    let total = v |> f |> g 1"
          "    total"
          "let nestedInBody () ="
          "    let total = g 1 (f v)"
          "    total"
          "let operand = 1 + g 1 (f v)"
          "let scaled = g 1 (f v) * 2"
          "let lens = [ \"a\"; \"bb\" ] |> List.map (fun s -> s.Length)"
          "let joined = System.String.Join(\",\", \"a\", \"b\")"
          "let named () = System.Console.WriteLine(value = 1)"
          "let commented = v |> (* keep *) f"
          "let callee = g 1 (* keep *) (f v)"
          "let job = async { return 1 }"
          "let banner () = printfn \"hi\""
          "let inLambda = [ v ] |> List.map (fun x -> g 1 (f x))"
          "let multiLambda () ="
          "    [ v ]"
          "    |> List.map (fun x -> g 1 (f x))"
          "let negated = -v"
          "let fns = [| f |]"
          "let byIndex = v |> fns.[0]"
          "let doBang () ="
          "    async {"
          "        do! lift v |> Async.Ignore"
          "    }"
          "let headCall = f v |> g 1"
          "let label = nameof v"
          "let rethrow () ="
          "    try 1"
          "    with _ -> reraise ()"
          "let negLiteral = -1 |> f"
          "type Adder() ="
          "    member _.Sum (a: int) (b: int) = a + b"
          "let adder = Adder()"
          "let summed = adder.Sum 1 (f v)"
          "let bannerParen () = printfn (\"hi\")"
          "let typed = id<int> (f v)" ]

let private pipeProject () = loadWorkspace [ "PipeFix.fs", PIPE_SOURCE ]

// ── Harness ─────────────────────────────────────────────────────

/// Code actions at a cursor, through the same entry point the conversion
/// quick-fix tests use.
let private actionsAt (state: FSharpWorkspace.FSharpWorkspaceState) (path: string) (line: int) (col: int) =
    task {
        let fixes = FSharpCodeFixes.createState ()
        let! actions = FSharpCodeFixes.getCodeActions fixes state path line col line 200
        return (fixes, actions)
    }

/// Resolve the single offered action with `title`, or None when it is absent.
let private resolveSole
    (fixes: FSharpCodeFixes.CodeFixState)
    (title: string)
    (actions: FSharpCodeFixes.CodeActionItem list)
    : FSharpCodeFixes.WorkspaceEdit option =
    match actions |> List.filter (fun a -> a.Title = title) with
    | [ sole ] -> FSharpCodeFixes.resolveCodeAction fixes sole.Id
    | [] -> None
    | many -> failwith $"expected at most one '{title}' action, got {many.Length}"

/// Apply a single-edit workspace edit to the whole-file source.
let private applyEdit (src: string) (edit: FSharpCodeFixes.TextEdit) : string =
    let lines = src.Split('\n')
    let line = lines[edit.StartLine]
    lines[edit.StartLine] <- line.Substring(0, edit.StartCharacter) + edit.NewText + line.Substring(edit.EndCharacter)
    String.concat "\n" lines

let private errorCount (check: FSharpCheckFileResults) =
    check.Diagnostics
    |> Array.filter (fun d -> d.Severity = FSharpDiagnosticSeverity.Error)
    |> Array.length

/// Offer → resolve → apply → assert the exact rewritten line, and that the
/// edited file type-checks with no new FCS errors.
let private assertConverted
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (path: string)
    (title: string)
    (line: int)
    (col: int)
    (expected: string)
    =
    task {
        let! fixes, actions = actionsAt state path line col
        match resolveSole fixes title actions with
        | None ->
            let offered = actions |> List.map (fun a -> a.Title) |> String.concat ", "
            return failwith $"no '{title}' action at {line}:{col}; offered: [{offered}]"
        | Some edit ->
            Assert.Single(edit.DocumentChanges) |> ignore
            Assert.Single(edit.DocumentChanges[0].Edits) |> ignore
            Assert.Equal("refactor", (actions |> List.find (fun a -> a.Title = title)).Kind)
            let edited = applyEdit PIPE_SOURCE edit.DocumentChanges[0].Edits[0]
            Assert.Equal(expected, edited.Split('\n')[line])
            let! checkedFile = FSharpWorkspace.checkFileWithSource state path edited
            match checkedFile with
            | None -> return failwith $"FCS could not re-check the edited file at {line}:{col}"
            | Some(_, check, _) -> return Assert.Equal(0, errorCount check)
    }

/// Assert that no refactoring action is offered at a position.
let private assertSilent (state: FSharpWorkspace.FSharpWorkspaceState) (path: string) (line: int) (col: int) =
    task {
        let! _, actions = actionsAt state path line col
        let refactors = actions |> List.filter (fun a -> a.Kind = "refactor") |> List.map _.Title
        Assert.Empty(refactors)
    }

// ── Pipeline → nested calls ─────────────────────────────────────

/// `v |> f` → `f v`; `v |> f |> g 1` → `g 1 (f v)` (stage arguments survive
/// and the non-atomic inner result is parenthesised); `w v |> f` → `f (w v)`
/// (the piped value is parenthesised unless atomic).
[<Fact>]
let ``pipeline converts to nested calls for single stage, stage arguments and a value needing parentheses`` () =
    task {
        let! state, dir, _, paths = pipeProject ()
        try
            do! assertConverted state paths[0] "Convert pipeline to nested calls" 9 11 "let p1 = f v"
            do! assertConverted state paths[0] "Convert pipeline to nested calls" 10 11 "let p2 = g 1 (f v)"
            do! assertConverted state paths[0] "Convert pipeline to nested calls" 11 13 "let p3 = f (w v)"
            // The opposite direction is never offered on a pipeline.
            let! fixes, actions = actionsAt state paths[0] 9 11
            Assert.True((resolveSole fixes "Convert nested calls to pipeline" actions).IsNone)
        finally
            cleanup dir
    }

// ── Nested calls → pipeline ─────────────────────────────────────

/// `f v` → `v |> f`; `g 1 (f v)` → `v |> f |> g 1`; `h 2 (g 1 (f (v + 1)))`
/// recurses through every trailing parenthesised application and keeps the
/// parenthesised value as the pipeline head.
[<Fact>]
let ``nested calls convert to a pipeline for single stage, stage arguments and nested parentheses`` () =
    task {
        let! state, dir, _, paths = pipeProject ()
        try
            do! assertConverted state paths[0] "Convert nested calls to pipeline" 12 9 "let n1 = v |> f"
            do! assertConverted state paths[0] "Convert nested calls to pipeline" 13 9 "let n2 = v |> f |> g 1"
            do! assertConverted state paths[0] "Convert nested calls to pipeline" 14 9 "let n3 = (v + 1) |> f |> g 1 |> h 2"
            // The opposite direction is never offered on a nested call.
            let! fixes, actions = actionsAt state paths[0] 12 9
            Assert.True((resolveSole fixes "Convert pipeline to nested calls" actions).IsNone)
        finally
            cleanup dir
    }

// ── Inside a function body ──────────────────────────────────────

/// Real pipelines sit inside multi-line function bodies: a body that spans
/// lines is looked inside, never mistaken for a multi-line chain.
[<Fact>]
let ``a pipeline and a nested call inside a multi-line function body convert`` () =
    task {
        let! state, dir, _, paths = pipeProject ()
        try
            do! assertConverted state paths[0] "Convert pipeline to nested calls" 28 18 "    let total = g 1 (f v)"
            do! assertConverted state paths[0] "Convert nested calls to pipeline" 31 16 "    let total = v |> f |> g 1"
        finally
            cleanup dir
    }

// ── Grouping and lambdas ────────────────────────────────────────

/// A pipeline binds looser than `+` and `*`, so a nested call that is an
/// operator operand converts to a parenthesised pipeline — unparenthesised,
/// `1 + v |> f |> g 1` would pipe `1 + v` instead.
[<Fact>]
let ``a nested call used as an operator operand converts to a parenthesised pipeline`` () =
    task {
        let! state, dir, _, paths = pipeProject ()
        try
            do! assertConverted state paths[0] "Convert nested calls to pipeline" 33 18 "let operand = 1 + (v |> f |> g 1)"
            do! assertConverted state paths[0] "Convert nested calls to pipeline" 34 13 "let scaled = (v |> f |> g 1) * 2"
        finally
            cleanup dir
    }

/// `|>` is left-associative, so a nested call at the head of a pipeline joins
/// it unparenthesised; the whole chain converts the other way at the same spot.
[<Fact>]
let ``a nested call at the head of a pipeline extends the chain`` () =
    task {
        let! state, dir, _, paths = pipeProject ()
        try
            do! assertConverted state paths[0] "Convert nested calls to pipeline" 53 15 "let headCall = v |> f |> g 1"
            do! assertConverted state paths[0] "Convert pipeline to nested calls" 53 15 "let headCall = g 1 (f v)"
        finally
            cleanup dir
    }

/// A negative literal stays one token after a space (`f -1` applies `f` to
/// `-1`), and a curried member or a generic type application partially applies
/// like any function, so each converts without the method-call guards getting
/// in the way.
[<Fact>]
let ``a negative literal value, a curried member and a generic type application convert`` () =
    task {
        let! state, dir, _, paths = pipeProject ()
        try
            do! assertConverted state paths[0] "Convert pipeline to nested calls" 58 20 "let negLiteral = f -1"
            do! assertConverted state paths[0] "Convert nested calls to pipeline" 62 13 "let summed = v |> f |> adder.Sum 1"
            do! assertConverted state paths[0] "Convert nested calls to pipeline" 64 12 "let typed = v |> f |> id<int>"
        finally
            cleanup dir
    }

/// A pipeline that cannot convert — its stage holds a lambda, or it spans
/// lines — never hides the nested call inside that lambda, which converts on
/// its own. The pipeline itself and its stage stay untouched.
[<Fact>]
let ``a nested call inside the lambda of an unconvertible pipeline converts`` () =
    task {
        let! state, dir, _, paths = pipeProject ()
        try
            do! assertConverted state paths[0] "Convert nested calls to pipeline" 42 43 "let inLambda = [ v ] |> List.map (fun x -> x |> f |> g 1)"
            do! assertConverted state paths[0] "Convert nested calls to pipeline" 45 26 "    |> List.map (fun x -> x |> f |> g 1)"
            do! assertSilent state paths[0] 42 24
        finally
            cleanup dir
    }

// ── Deliberate refusals ─────────────────────────────────────────

/// Withheld where the rewrite would stop compiling or drop source: a stage
/// lambda whose parameter type would no longer flow from the piped value
/// (FS0072), a method's argument list (ParamArray, named argument), a comment
/// inside the expression, a computation-expression body, a format string, a
/// bare prefix operator or the `nameof`/`reraise` intrinsics, which apply only
/// in place, a stage that is neither a function reference nor an application,
/// a `do!` right-hand side, and a parenthesised format string.
[<Fact>]
let ``pipe conversions stay silent where the rewrite would not compile or would drop a comment`` () =
    task {
        let! state, dir, _, paths = pipeProject ()
        try
            do! assertSilent state paths[0] 35 28
            do! assertSilent state paths[0] 36 27
            do! assertSilent state paths[0] 37 30
            do! assertSilent state paths[0] 38 16
            do! assertSilent state paths[0] 39 13
            do! assertSilent state paths[0] 40 10
            do! assertSilent state paths[0] 41 16
            do! assertSilent state paths[0] 46 14
            do! assertSilent state paths[0] 48 16
            do! assertSilent state paths[0] 51 19
            do! assertSilent state paths[0] 54 12
            do! assertSilent state paths[0] 57 14
            do! assertSilent state paths[0] 63 21
        finally
            cleanup dir
    }

/// A lambda pipeline stage cannot be placed as the last argument of anything,
/// a multi-line chain cannot be reproduced faithfully, and a computation
/// expression's `let!` right-hand side must not be rewritten. The same shape
/// outside the computation expression DOES convert, proving the silence is
/// the guards at work and not a broken lookup.
[<Fact>]
let ``pipe conversions stay silent on lambda stages, plain bindings, multi-line chains and computation-expression let!`` () =
    task {
        let! state, dir, _, paths = pipeProject ()
        try
            do! assertConverted state paths[0] "Convert pipeline to nested calls" 16 21 "let outside = id (lift v)"
            do! assertSilent state paths[0] 15 18
            do! assertSilent state paths[0] 15 29
            do! assertSilent state paths[0] 17 12
            do! assertSilent state paths[0] 19 4
            do! assertSilent state paths[0] 20 6
            do! assertSilent state paths[0] 24 24
        finally
            cleanup dir
    }

// ── Robustness ──────────────────────────────────────────────────

/// The conversions read only the parse they were handed: a source that no
/// longer matches it, or a signature file, offers nothing and never throws.
[<Fact>]
let ``a stale source or a signature file offers no pipe conversion`` () =
    task {
        let! state, dir, _, paths = pipeProject ()
        try
            let! checkedFile = FSharpWorkspace.checkFileWithSource state paths[0] PIPE_SOURCE
            let parseResults =
                match checkedFile with
                | Some(parsed, _, _) -> parsed
                | None -> failwith "FCS could not check the pipe fixture"
            let current = FSharpPipeRefactoring.tryGenerateActions parseResults PIPE_SOURCE paths[0] 9 11
            Assert.Equal<string list>([ "Convert pipeline to nested calls" ], current |> List.map _.Title)
            Assert.Empty(FSharpPipeRefactoring.tryGenerateActions parseResults "" paths[0] 9 11)
            let signature = "module PipeFix\n\nval v: int\n"
            let options = { FSharpParsingOptions.Default with SourceFiles = [| "PipeFix.fsi" |] }
            let! parsedSignature =
                state.Checker.ParseFile("PipeFix.fsi", SourceText.ofString signature, options) |> Async.StartAsTask
            Assert.Empty(FSharpPipeRefactoring.tryGenerateActions parsedSignature signature "PipeFix.fsi" 2 4)
        finally
            cleanup dir
    }
