/// Fix-all for the F# quick fixes: one fix, every occurrence of a scope
/// (document / project / solution), resolved through the workspace's
/// `FSharpProjectOptions` and merged per file from AST ranges. Overlapping
/// edits are dropped and reported, never merged by text, and a fix-all that
/// fixes nothing refuses with a plain-words reason instead of an empty edit.
/// Implements [FIXALL-SCOPES] for F# (GitHub #577).
module SharpLsp.Sidecar.FSharp.FSharpFixAll

open System
open System.Threading
open System.Threading.Tasks
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open Serilog
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.FSharpCodeActions
open SharpLsp.Sidecar.FSharp.FSharpCodeFixes

// ── Types ────────────────────────────────────────────────────────

/// What one fix-all produced: its per-file edits and how many overlapping
/// edits were dropped, or the plain-words reason it refused to run at all.
[<NoComparison; NoEquality>]
type FixAllOutcome =
    | Applied of edits: DocumentEdit list * droppedOverlaps: int
    | Refused of reason: string

/// The reason the dead-declaration fix refuses while its analyzer is off:
/// fixing nothing silently would hide the switch from the user.
/// [REFACTOR-NEVER-SILENT]
let private ANALYZER_OFF =
    "the dead-code analyzer is off: turn it on in [analyzers] to fix all unused declarations"

// ── Scope resolution ─────────────────────────────────────────────

/// The files a scope spans, anchored on `filePath`: the anchor alone at
/// document scope, the owning `FSharpProjectOptions`' own files at project
/// scope ([FIXALL-SCOPES]), and every loaded F# project's files at solution
/// scope. Errors carry the plain-words refusal reason.
let private scopeFiles (state: FSharpWorkspace.FSharpWorkspaceState) filePath (scope: string) : Result<string array, string> =
    match scope with
    | "document" -> Ok [| filePath |]
    | "project" ->
        match FSharpWorkspace.queryScope state filePath |> List.tryHead with
        | Some own -> Ok own.SourceFiles
        | None -> Error "the document is not part of a loaded F# project"
    | "solution" -> Ok(FSharpWorkspace.allSourceFiles state)
    | _ -> Error $"the scope '{scope}' is not one this fix supports"

// ── Edit merging ─────────────────────────────────────────────────

/// Whether two 0-based half-open ranges overlap: each starts before the other ends.
let private overlapping (kept: TextEdit) (next: TextEdit) =
    (next.StartLine, next.StartCharacter) < (kept.EndLine, kept.EndCharacter)
    && (kept.StartLine, kept.StartCharacter) < (next.EndLine, next.EndCharacter)

/// Merge one file's edits: identical findings become one edit, the rest keep
/// document order, and an edit overlapping a kept one is dropped and counted —
/// never merged by text. [FIXALL-SCOPES]
let internal mergeFileEdits (edits: TextEdit list) : TextEdit list * int =
    let order e = (e.StartLine, e.StartCharacter, e.EndLine, e.EndCharacter)
    let sorted = edits |> List.distinctBy (fun e -> (order e, e.NewText)) |> List.sortBy order

    let rec keep kept dropped pending =
        match pending with
        | [] -> List.rev kept, dropped
        | edit :: rest ->
            match kept with
            | latest :: _ when overlapping latest edit -> keep kept (dropped + 1) rest
            | _ -> keep (edit :: kept) dropped rest

    keep [] 0 sorted

// ── One fix's findings in one file ───────────────────────────────

/// The unused-open deletions of a file, whole lines from FCS's ranges.
let private unusedOpens (check: FSharpCheckFileResults) source filePath =
    task {
        let! findings = FSharpLocalAnalysis.getFileAnalyzerFindings check source
        return
            findings.UnusedOpens
            |> List.map (fun r -> rangeEdit filePath (FSharpQuickFix.wholeLines r) "")
    }

/// The redundant-qualifier deletions of a file.
let private simplifiableNames (check: FSharpCheckFileResults) source filePath =
    task {
        let! findings = FSharpLocalAnalysis.getFileAnalyzerFindings check source
        return findings.SimplifiableNames |> List.map (fun (r, _) -> rangeEdit filePath r "")
    }

/// The `fix` edits of every diagnostic carrying `number` in `check`.
let private diagnosticsFix (check: FSharpCheckFileResults) number (fix: FSharp.Compiler.Text.range -> GeneratedAction list) =
    check.Diagnostics
    |> Array.filter (fun d -> d.ErrorNumber = number)
    |> Seq.collect (fun d -> fix d.Range)
    |> Seq.collect (fun action -> action.Edits)
    |> List.ofSeq

/// The dead-declaration deletions of a file, from the analyzer's own findings.
let private deadDeclarations state analyzers parse (check: FSharpCheckFileResults) source filePath ct =
    task {
        match analyzers with
        | None -> return []
        | Some config ->
            let! dead = FSharpAnalyzers.deadCodeInFile state config filePath ct
            let deletable = FSharpDeadCodeFixes.declaredOn parse 0 Int32.MaxValue
            return
                dead
                |> List.choose (FSharpDeadCodeFixes.removal check source filePath deletable)
                |> List.collect (fun action -> action.Edits)
    }

/// The finding edits of `fixKey` in one file, computed with the same query the
/// single-site fix and the diagnostics use — FCS's ranges, never titles.
/// None when the file cannot be checked at all. [FIXALL-SCOPES]
let private findingsInFile
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (analyzers: FSharpAnalyzers.AnalyzerConfig option)
    (fixKey: string)
    (filePath: string)
    (ct: CancellationToken)
    : Task<RawEdit list option> =
    task {
        match! FSharpWorkspace.checkFileWithParseWithCancellation state filePath ct with
        | None -> return None
        | Some(parse, check, source) ->
            let! raw =
                match fixKey with
                | FixAllKeys.RemoveUnusedOpen -> unusedOpens check source filePath
                | FixAllKeys.SimplifyName -> simplifiableNames check source filePath
                | FixAllKeys.PrefixUnusedValue ->
                    diagnosticsFix check 1182 (FSharpNameFixes.unused source filePath) |> Task.FromResult
                | FixAllKeys.AddNewForDisposable ->
                    diagnosticsFix check 760 (FSharpNameFixes.addNew parse filePath) |> Task.FromResult
                | FixAllKeys.RemoveUnusedDeclaration ->
                    deadDeclarations state analyzers parse check source filePath ct
                | _ -> Task.FromResult []

            return Some raw
    }

/// One file's merged findings of `fixKey`, in document order, and how many
/// overlapping edits were dropped — or None when the file cannot be checked.
/// [FIXALL-SCOPES]
let private mergedFindings
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (analyzers: FSharpAnalyzers.AnalyzerConfig option)
    (fixKey: string)
    (file: string)
    (ct: CancellationToken)
    : Task<(TextEdit list * int) option> =
    task {
        let! raw = findingsInFile state analyzers fixKey file ct
        return raw |> Option.map (List.map ofRawEdit >> mergeFileEdits)
    }

/// The reason a fix-all refuses before it starts: an unknown key, or the
/// dead-declaration fix without its analyzer. An unusable scope refuses in `scopeFiles`.
let private refusalOf (analyzers: FSharpAnalyzers.AnalyzerConfig option) (fixKey: string) =
    let known =
        [ FixAllKeys.RemoveUnusedOpen
          FixAllKeys.SimplifyName
          FixAllKeys.PrefixUnusedValue
          FixAllKeys.AddNewForDisposable
          FixAllKeys.RemoveUnusedDeclaration ]

    if not (List.contains fixKey known) then Some $"no F# fix answers the key '{fixKey}'"
    elif fixKey = FixAllKeys.RemoveUnusedDeclaration && analyzers.IsNone then Some ANALYZER_OFF
    else None

// ── The fix-all itself ───────────────────────────────────────────

/// Fold one file's merged findings into the documents so far and the overlaps
/// dropped so far; overlaps are reported, never merged by text. [FIXALL-SCOPES]
let private collect fixKey file (documents, droppedOverlaps) merged =
    match merged with
    | None -> documents, droppedOverlaps
    | Some(edits: TextEdit list, dropped) ->
        if dropped > 0 then
            Log.Warning("[FixAll] dropped {Dropped} overlapping edits of {FixKey} in {File}", dropped, fixKey, file)

        let documents = if edits.IsEmpty then documents else { FilePath = file; Edits = edits } :: documents
        documents, droppedOverlaps + dropped

/// The outcome of the documents a fix-all edited: refused when it edited none.
let private outcomeOf fixKey scope (documents: DocumentEdit list, droppedOverlaps) =
    match documents with
    | [] -> Refused $"no occurrences of the fix '{fixKey}' remain in the {scope}"
    | _ -> Applied(documents |> List.sortWith (fun a b -> NativePaths.Comparer.Compare(a.FilePath, b.FilePath)), droppedOverlaps)

/// Every file's merged findings of `fixKey`, folded in file order.
let private fixFiles state analyzers fixKey (files: string array) (ct: CancellationToken) =
    task {
        let mutable folded = [], 0

        for file in files do
            ct.ThrowIfCancellationRequested()
            let! merged = mergedFindings state analyzers fixKey file ct
            folded <- collect fixKey file folded merged

        return folded
    }

/// Run one fix at every occurrence of its `scope`, anchored on `filePath`.
/// `analyzers` is the analyzer configuration while the analyzers are on —
/// the dead-declaration fix needs it and refuses without it. [FIXALL-SCOPES]
let fixAll
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (analyzers: FSharpAnalyzers.AnalyzerConfig option)
    (filePath: string)
    (fixKey: string)
    (scope: string)
    (ct: CancellationToken)
    : Task<FixAllOutcome> =
    task {
        match refusalOf analyzers fixKey, scopeFiles state filePath scope with
        | Some reason, _
        | None, Error reason -> return Refused reason
        | None, Ok files when files.Length = 0 -> return Refused "no F# projects are loaded"
        | None, Ok files ->
            let! folded = fixFiles state analyzers fixKey files ct
            return outcomeOf fixKey scope folded
    }
