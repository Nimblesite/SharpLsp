/// FS0039 "Replace with" and FS0760 "Add 'new'" quick fixes driven through the
/// real code-action pipeline over a real parsed .fsproj fixture: offered at
/// the diagnostic, resolved, applied, and the edited file re-checked by FCS.
/// Implements [ANALYZERS-FSAC-CODEFIX-TYPO] / [ANALYZERS-FSAC-CODEFIX-ADD-NEW].
module SharpLsp.Sidecar.FSharp.Tests.FSharpNameFixTests

open FSharp.Compiler.Diagnostics
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCodeActionKit
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

// Each file holds exactly one problem, so a fix leaves its file error-free.
let private TYPOS = source [ "module Typos"; ""; "let length = 3"; "let total = lenght + 1" ]

let private MEMBERS = source [ "module Members"; ""; "let text = \"abc\""; "let size = text.Lenght" ]

let private UNMATCHED = source [ "module Unmatched"; ""; "let other = qqqzzz" ]

let private DISPOSABLES =
    source
        [ "module Disposables"
          ""
          "let reader = System.IO.StringReader(\"x\")"
          "let readers = [ \"a\" ] |> List.map System.IO.StringReader" ]

let private OPENS =
    source [ "namespace Shapes"; ""; "module Area ="; "    let joined = Path.Combine(\"a\", \"b\")" ]

let private BUILDERS = source [ "module Builders"; ""; "let builder = StringBuilder()" ]

let private TIMERS = source [ "module Timers"; ""; "let stop (timer: Timer) = timer.Dispose()" ]

let private ATTRIBUTES = source [ "module Attributes"; ""; "[<Obsolete(\"old\")>]"; "let legacy = 1" ]

let private nameFixProject () =
    loadWorkspace
        [ "Typos.fs", TYPOS
          "Members.fs", MEMBERS
          "Unmatched.fs", UNMATCHED
          "Disposables.fs", DISPOSABLES
          "Opens.fs", OPENS
          "Builders.fs", BUILDERS
          "Timers.fs", TIMERS
          "Attributes.fs", ATTRIBUTES ]

let private replaceTitlesAt state path line col =
    task {
        let! titles = titlesOfKind state path "quickfix" line col
        return titles |> List.filter _.StartsWith("Replace with")
    }

// ── FS0039: did you mean ────────────────────────────────────────

/// A misspelled value and a misspelled member are each replaced by the
/// closest name FCS has in scope there, and the file then compiles.
[<Fact>]
let ``a misspelled value or member is replaced with the closest name in scope`` () =
    task {
        let! state, dir, _, paths = nameFixProject ()
        try
            let! valueFixed = applyAction state paths[0] TYPOS "quickfix" "Replace with 'length'" (3, 12) "let total = length + 1"
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error valueFixed)
            let! memberFixed = applyAction state paths[1] MEMBERS "quickfix" "Replace with 'Length'" (3, 16) "let size = text.Length"
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error memberFixed)
        finally
            cleanup dir
    }

/// A name with nothing similar in scope offers no replacement at all.
[<Fact>]
let ``an undefined name with nothing similar in scope offers no replacement`` () =
    task {
        let! state, dir, _, paths = nameFixProject ()
        try
            let! _, checkedFile, _ = checkedFixture state paths[2]
            Assert.Equal<int array>([| 2 |], linesWith 39 checkedFile)
            let! titles = replaceTitlesAt state paths[2] 2 12
            Assert.Empty(titles)
        finally
            cleanup dir
    }

// ── FS0760: add new ─────────────────────────────────────────────

/// A disposable constructor call gains `new`, silencing FS0760; the same
/// warning on a constructor used as a function value offers nothing, since
/// `new` cannot prefix a function value.
[<Fact>]
let ``a disposable constructor call gains new but a constructor function value does not`` () =
    task {
        let! state, dir, _, paths = nameFixProject ()
        try
            let! _, before, _ = checkedFixture state paths[3]
            Assert.Equal<int array>([| 2; 3 |], linesWith 760 before)
            let! fixedFile =
                applyAction state paths[3] DISPOSABLES "quickfix" "Add 'new'" (2, 13) "let reader = new System.IO.StringReader(\"x\")"
            Assert.Equal<int array>([| 3 |], linesWith 760 fixedFile)
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error fixedFile)
            let! titles = titlesOfKind state paths[3] "quickfix" 3 34
            Assert.DoesNotContain("Add 'new'", titles)
        finally
            cleanup dir
    }

// ── FS0039: open the namespace ──────────────────────────────────

/// The `open` lands where FCS says one may stand — inside the nested module,
/// at its indentation — so the file compiles; the misspelling fix stays
/// silent, since `Path` is spelt right.
[<Fact>]
let ``an undefined type from a known namespace is opened inside its module`` () =
    task {
        let! state, dir, _, paths = nameFixProject ()
        try
            let! _, before, _ = checkedFixture state paths[4]
            Assert.Equal<int array>([| 3 |], linesWith 39 before)
            let! opened = applyActionAt state paths[4] OPENS "quickfix" "Add 'open System.IO'" (3, 17) (3, "    open System.IO")
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error opened)
            let! titles = replaceTitlesAt state paths[4] 3 17
            Assert.Empty(titles)
        finally
            cleanup dir
    }

/// Any referenced namespace, not a known few: StringBuilder opens System.Text;
/// a type two namespaces declare offers each, in order, and only where a type
/// fits (never a module's value of that name); either leaves the file clean;
/// and an attribute named without its suffix opens its namespace too.
[<Fact>]
let ``an undefined type opens whichever referenced namespace declares it`` () =
    task {
        let! state, dir, _, paths = nameFixProject ()
        try
            // 1. One namespace declares StringBuilder: its `open` goes below the module's gap.
            let! built = applyActionAt state paths[5] BUILDERS "quickfix" "Add 'open System.Text'" (2, 14) (2, "open System.Text")
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error built)

            // 2. Two declare Timer: both are offered, in order.
            let! titles = titlesOfKind state paths[6] "quickfix" 2 18
            let opens = titles |> List.filter (fun title -> title.StartsWith "Add 'open ")
            Assert.Equal<string list>([ "Add 'open System.Threading'"; "Add 'open System.Timers'" ], opens)

            // 3. Either resolves the name.
            let! timers = applyActionAt state paths[6] TIMERS "quickfix" "Add 'open System.Timers'" (2, 18) (2, "open System.Timers")
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error timers)

            // 4. An attribute named without its suffix opens its namespace too.
            let! attributed = applyActionAt state paths[7] ATTRIBUTES "quickfix" "Add 'open System'" (2, 3) (2, "open System")
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error attributed)
        finally
            cleanup dir
    }

/// The project's own namespaces count too: a type another file declares in a
/// namespace this file has not opened gets that namespace's `open`.
[<Fact>]
let ``an undefined type of the project's own namespace opens it`` () =
    task {
        let geometry = source [ "namespace Geometry"; ""; "type Circle = { Radius: float }" ]
        let drawing = source [ "module Drawing"; ""; "let area (c: Circle) = c.Radius * c.Radius" ]
        let! state, dir, _, paths = loadWorkspace [ "Geometry.fs", geometry; "Drawing.fs", drawing ]
        try
            let! opened = applyActionAt state paths[1] drawing "quickfix" "Add 'open Geometry'" (2, 13) (2, "open Geometry")
            Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error opened)
        finally
            cleanup dir
    }

// ── Robustness ──────────────────────────────────────────────────

/// The fixes read only the source they were handed: when it no longer holds
/// the diagnostic's text, nothing is offered and nothing throws.
[<Fact>]
let ``a stale source offers no name fix`` () =
    task {
        let! state, dir, _, paths = nameFixProject ()
        try
            let! parse, check, current = checkedFixture state paths[0]
            let typo = check.Diagnostics |> Array.find (fun d -> d.ErrorNumber = 39)
            let titles text = FSharpNameFixes.typos parse check text paths[0] typo.Range |> List.map _.Title
            Assert.Equal<string list>([ "Replace with 'length'" ], titles current)
            Assert.Empty(titles "")
        finally
            cleanup dir
    }

