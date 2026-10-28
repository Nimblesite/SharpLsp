/// The code-action harness shared by the F# refactoring and quick-fix suites:
/// offer actions at a cursor through the editor's entry point
/// (FSharpCodeFixes.getCodeActions), resolve one, apply its edit to the fixture
/// source and let FCS re-check the result.
module SharpLsp.Sidecar.FSharp.Tests.FSharpCodeActionKit

open System.Threading
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open Xunit
open SharpLsp.Sidecar.FSharp

/// FCS's parse, check and source of a fixture file as it stands.
let checkedFixture (state: FSharpWorkspace.FSharpWorkspaceState) (path: string) =
    task {
        match! FSharpWorkspace.checkFileWithParse state path with
        | None -> return failwith $"FCS could not check {path}"
        | Some(parse, check, src) -> return (parse, check, src)
    }

/// Code actions at a cursor, through the same entry point the editor uses, with
/// the fixes of the `analyzers` configuration (None: the analyzers are off).
let actionsWith analyzers (state: FSharpWorkspace.FSharpWorkspaceState) (path: string) (line: int) (col: int) =
    task {
        let fixes = FSharpCodeFixes.createState ()
        let! actions = FSharpCodeFixes.getCodeActions fixes state analyzers path line col line 200 CancellationToken.None
        return (fixes, actions)
    }

/// Code actions at a cursor with the analyzers off.
let actionsAt state path line col = actionsWith None state path line col

/// Resolve the single offered action with `title`, or None when it is absent.
let resolveSole
    (fixes: FSharpCodeFixes.CodeFixState)
    (title: string)
    (actions: FSharpCodeFixes.CodeActionItem list)
    : FSharpCodeFixes.WorkspaceEdit option =
    match actions |> List.filter (fun a -> a.Title = title) with
    | [ sole ] -> FSharpCodeFixes.resolveCodeAction fixes sole.Id
    | [] -> None
    | many -> failwith $"expected at most one '{title}' action, got {many.Length}"

/// The offset of 0-based `line`, `character` in `src`; a line past the end is its end.
let private offsetOf (src: string) (line: int) (character: int) =
    let lines = src.Split('\n')
    if line >= lines.Length then src.Length
    else (lines |> Array.take line |> Array.sumBy (fun text -> text.Length + 1)) + character

/// Apply an edit, on one line or across several, to the whole-file source.
let applyEdit (src: string) (edit: FSharpCodeFixes.TextEdit) : string =
    let start = offsetOf src edit.StartLine edit.StartCharacter
    let finish = offsetOf src edit.EndLine edit.EndCharacter
    src.Substring(0, start) + edit.NewText + src.Substring(finish)

/// The 0-based lines carrying a diagnostic `code` in a check, in order.
let linesWith (code: int) (check: FSharpCheckFileResults) =
    check.Diagnostics
    |> Array.filter (fun d -> d.ErrorNumber = code)
    |> Array.map (fun d -> d.StartLine - 1)
    |> Array.sort

/// The diagnostics of `severity` in a check.
let diagnosticsOf (severity: FSharpDiagnosticSeverity) (check: FSharpCheckFileResults) =
    check.Diagnostics |> Array.filter (fun d -> d.Severity = severity)

/// Offer → resolve → apply the action titled `title` at a cursor, with the
/// fixes of `analyzers`. Asserts it is the only one with that title, its kind,
/// that it is one edit, and the exact text of line `expectedLine` afterwards;
/// returns FCS's check of the edited file.
let applyActionWith
    analyzers
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (path: string)
    (fixture: string)
    (kind: string)
    (title: string)
    (line: int, col: int)
    (expectedLine: int, expected: string)
    =
    task {
        let! fixes, actions = actionsWith analyzers state path line col

        match resolveSole fixes title actions with
        | None ->
            let offered = actions |> List.map (fun a -> a.Title) |> String.concat ", "
            return failwith $"no '{title}' action at {line}:{col}; offered: [{offered}]"
        | Some edit ->
            Assert.Single(edit.DocumentChanges) |> ignore
            Assert.Single(edit.DocumentChanges[0].Edits) |> ignore
            Assert.Equal(kind, (actions |> List.find (fun a -> a.Title = title)).Kind)
            let edited = applyEdit fixture edit.DocumentChanges[0].Edits[0]
            Assert.Equal(expected, edited.Split('\n')[expectedLine])

            match! FSharpWorkspace.checkFileWithSource state path edited with
            | None -> return failwith $"FCS could not re-check the edited file at {line}:{col}"
            | Some(_, check, _) -> return check
    }

/// `applyActionWith` with the analyzers off.
let applyActionAt state path fixture kind title cursor expected =
    applyActionWith None state path fixture kind title cursor expected

/// `applyActionAt` for an edit in place, checked on the cursor's own line.
let applyAction state path fixture kind title (line: int, col: int) (expected: string) =
    applyActionAt state path fixture kind title (line, col) (line, expected)

/// The titles of the actions of `kind` offered at a cursor.
let titlesOfKind (state: FSharpWorkspace.FSharpWorkspaceState) (path: string) (kind: string) (line: int) (col: int) =
    task {
        let! _, actions = actionsAt state path line col
        return actions |> List.filter (fun a -> a.Kind = kind) |> List.map _.Title
    }
