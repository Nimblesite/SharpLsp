/// FS0025 "Add wildcard case" driven through the real code-action pipeline over
/// a real parsed .fsproj fixture: offered at the incomplete match, resolved,
/// applied, and the edited file re-checked by FCS.
/// Implements [ANALYZERS-FSAC-CODEFIX-COMPILER].
module SharpLsp.Sidecar.FSharp.Tests.FSharpMatchFixTests

open FSharp.Compiler.Diagnostics
open Xunit
open SharpLsp.Sidecar.FSharp.Tests.FSharpCodeActionKit
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

//  6:     match a with
//  7:     | X ->
//  8:         match b with
//  9:         | P -> 1
// 10:         | Q -> 2
// 11:     | Y -> 3
let private NESTED =
    source
        [ "module Matches"
          ""
          "type Outer = X | Y"
          "type Inner = P | Q | R"
          ""
          "let nested (a: Outer) (b: Inner) ="
          "    match a with"
          "    | X ->"
          "        match b with"
          "        | P -> 1"
          "        | Q -> 2"
          "    | Y -> 3" ]

let private TITLE = "Add wildcard case '| _ ->'"

/// The wildcard completes the match FCS reported — the inner one, after its own
/// last case and at its indentation — never the enclosing match whose case
/// follows it, which would stay complete and gain a rule that never matches.
[<Fact>]
let ``an incomplete inner match gains its wildcard after its own last case`` () =
    task {
        let! state, dir, _, paths = loadWorkspace [ "Matches.fs", NESTED ]
        try
            let! _, before, _ = checkedFixture state paths[0]
            Assert.Equal<int array>([| 8 |], linesWith 25 before)
            let! completed =
                applyActionAt state paths[0] NESTED "quickfix" TITLE (8, 8) (11, "        | _ -> failwith \"Unhandled case\"")
            Assert.Empty(linesWith 25 completed)
            Assert.Empty(linesWith 26 completed)
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error completed)
        finally
            cleanup dir
    }

/// A first clause may omit its bar: the wildcard then lines up with its
/// pattern, under the clause it follows.
[<Fact>]
let ``a match whose only clause has no bar gains a wildcard lined up with its pattern`` () =
    task {
        let first = source [ "module First"; ""; "type Inner = P | Q | R"; ""; "let first (b: Inner) ="; "    match b with"; "    P -> 1" ]
        let! state, dir, _, paths = loadWorkspace [ "First.fs", first ]
        try
            let! _, before, _ = checkedFixture state paths[0]
            Assert.Equal<int array>([| 5 |], linesWith 25 before)
            let! completed = applyActionAt state paths[0] first "quickfix" TITLE (5, 4) (7, "    | _ -> failwith \"Unhandled case\"")
            Assert.Empty(linesWith 25 completed)
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error completed)
        finally
            cleanup dir
    }

