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
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
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
let private analyzerOff =
    "the dead-code analyzer is off: turn it on in [analyzers] to fix all unused declarations"

// ── Scope resolution ─────────────────────────────────────────────

/// Whether `file` is build output of the project `options` loads — MSBuild's
/// generated `obj/…AssemblyInfo.fs` and the like — which a fix never edits.
/// [FIXALL-SCOPES]
let private generated (options: FSharpProjectOptions) (file: string) =
    let projectDir = NativePaths.DirectoryOf options.ProjectFileName
    [ "obj"; "bin" ] |> List.exists (fun output -> NativePaths.IsWithin(NativePaths.Resolve(projectDir, output), file))

/// The hand-written files `options` compile.
let private ownFiles (options: FSharpProjectOptions) =
    options.SourceFiles |> Array.filter (generated options >> not)

/// The files a scope spans, anchored on `filePath`: the anchor alone at
/// document scope, the owning `FSharpProjectOptions`' own files at project
/// scope ([FIXALL-SCOPES]), and every loaded F# project's files at solution
/// scope — never build output. Errors carry the plain-words refusal reason.
let private scopeFiles (state: FSharpWorkspace.FSharpWorkspaceState) filePath (scope: string) : Result<string array, string> =
    match scope with
    | "document"
    | "containingMember"
    | "containingType" -> Ok [| filePath |]
    | "project" ->
        match FSharpWorkspace.queryScope state filePath |> List.tryHead with
        | Some own -> Ok(ownFiles own)
        | None -> Error "the document is not part of a loaded F# project"
    | "solution" ->
        FSharpWorkspace.projectOptions state
        |> Seq.collect ownFiles
        |> Seq.distinctBy NativePaths.NormalizeFullPath
        |> Array.ofSeq
        |> Ok
    | _ -> Error $"the scope '{scope}' is not one this fix supports"

/// Find the innermost enclosing AST binding (`containingMember`) or type
/// definition (`containingType`) containing 0-based `anchorLine`. [FIXALL-SCOPES]
let internal enclosingRange (parse: FSharpParseFileResults) (scope: string) (anchorLine: int) : range option =
    let line1 = anchorLine + 1
    let contains (r: range) = r.StartLine <= line1 && line1 <= r.EndLine
    let smaller (a: range) (b: range) = (a.EndLine - a.StartLine) < (b.EndLine - b.StartLine)
    let pick current candidate =
        if not (contains candidate) then current
        else
            match current with
            | None -> Some candidate
            | Some prev -> if smaller candidate prev then Some candidate else Some prev

    let rec walkDecls wantType best decls =
        (best, decls)
        ||> List.fold (fun acc decl ->
            match decl with
            | SynModuleDecl.Let(_, bindings, _, _) when not wantType ->
                (acc, bindings) ||> List.fold (fun b binding -> pick b binding.RangeOfBindingWithRhs)
            | SynModuleDecl.Types(types, _) ->
                (acc, types)
                ||> List.fold (fun b (SynTypeDefn(_, repr, members, _, r, _)) ->
                    let b = if wantType then pick b r else b
                    if wantType then b
                    else
                        let fromMembers =
                            (b, members)
                            ||> List.fold (fun m mem ->
                                match mem with
                                | SynMemberDefn.Member(binding, _) -> pick m binding.RangeOfBindingWithRhs
                                | SynMemberDefn.LetBindings(bindings, _, _, _, _) ->
                                    (m, bindings) ||> List.fold (fun x bd -> pick x bd.RangeOfBindingWithRhs)
                                | _ -> m)
                        match repr with
                        | SynTypeDefnRepr.ObjectModel(_, reprMembers, _) ->
                            (fromMembers, reprMembers)
                            ||> List.fold (fun m mem ->
                                match mem with
                                | SynMemberDefn.Member(binding, _) -> pick m binding.RangeOfBindingWithRhs
                                | _ -> m)
                        | _ -> fromMembers)
            | SynModuleDecl.NestedModule(_, _, nested, _, _, _) -> walkDecls wantType acc nested
            | _ -> acc)

    match parse.ParseTree with
    | ParsedInput.ImplFile(ParsedImplFileInput(contents = modules)) ->
        let wantType = scope = "containingType"
        (None, modules)
        ||> List.fold (fun acc (SynModuleOrNamespace(decls = decls)) -> walkDecls wantType acc decls)
    | _ -> None

let private withinScope (limit: range option) (edit: TextEdit) =
    match limit with
    | None -> true
    | Some r ->
        let start1 = edit.StartLine + 1
        let end1 = edit.EndLine + 1
        start1 >= r.StartLine && end1 <= r.EndLine

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
    (scope: string)
    (anchorLine: int option)
    (filePath: string)
    (ct: CancellationToken)
    : Task<(RawEdit list * range option) option> =
    task {
        match! FSharpWorkspace.checkFileWithParseWithCancellation state filePath ct with
        | None -> return None
        | Some(parse, check, source) ->
            let limit =
                match scope, anchorLine with
                | ("containingMember" | "containingType"), Some line -> enclosingRange parse scope line
                | _ -> None

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

            return Some(raw, limit)
    }

/// One file's merged findings of `fixKey`, in document order, and how many
/// overlapping edits were dropped — or None when the file cannot be checked.
/// [FIXALL-SCOPES]
let private mergedFindings
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (analyzers: FSharpAnalyzers.AnalyzerConfig option)
    (fixKey: string)
    (scope: string)
    (anchorLine: int option)
    (file: string)
    (ct: CancellationToken)
    : Task<(TextEdit list * int) option> =
    task {
        let! found = findingsInFile state analyzers fixKey scope anchorLine file ct
        return
            found
            |> Option.map (fun (raw, limit) ->
                raw
                |> List.map ofRawEdit
                |> List.filter (withinScope limit)
                |> mergeFileEdits)
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
    elif fixKey = FixAllKeys.RemoveUnusedDeclaration && analyzers.IsNone then Some analyzerOff
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
let private fixFiles state analyzers fixKey scope anchorLine (files: string array) (ct: CancellationToken) =
    task {
        let mutable folded = [], 0

        for file in files do
            ct.ThrowIfCancellationRequested()
            let! merged = mergedFindings state analyzers fixKey scope anchorLine file ct
            folded <- collect fixKey file folded merged

        return folded
    }

/// Run one fix at every occurrence of its `scope`, anchored on `filePath` and
/// optional 0-based `anchorLine` (used for `containingMember` / `containingType`).
/// [FIXALL-SCOPES]
let fixAllAt
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (analyzers: FSharpAnalyzers.AnalyzerConfig option)
    (filePath: string)
    (fixKey: string)
    (scope: string)
    (anchorLine: int option)
    (ct: CancellationToken)
    : Task<FixAllOutcome> =
    task {
        match refusalOf analyzers fixKey, scopeFiles state filePath scope with
        | Some reason, _
        | None, Error reason -> return Refused reason
        | None, Ok files when files.Length = 0 -> return Refused "no F# projects are loaded"
        | None, Ok files ->
            let! folded = fixFiles state analyzers fixKey scope anchorLine files ct
            return outcomeOf fixKey scope folded
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
    fixAllAt state analyzers filePath fixKey scope None ct
