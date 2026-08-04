/// F# code fixes via FSharp.Compiler.Service diagnostics.
/// Maps FCS diagnostic codes to concrete text edits.
module SharpLsp.Sidecar.FSharp.FSharpCodeFixes

open System
open System.Collections.Concurrent
open System.Text.RegularExpressions
open System.Threading
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open FSharp.Compiler.Text
open Serilog

// ── Types ────────────────────────────────────────────────────────

[<NoComparison; NoEquality>]
type CodeActionItem =
    { Id: int
      Title: string
      Kind: string
      IsPreferred: bool }

[<NoComparison; NoEquality>]
type TextEdit =
    { StartLine: int
      StartCharacter: int
      EndLine: int
      EndCharacter: int
      NewText: string }

[<NoComparison; NoEquality>]
type DocumentEdit =
    { FilePath: string
      Edits: TextEdit list }

[<NoComparison; NoEquality>]
type WorkspaceEdit =
    { DocumentChanges: DocumentEdit list }

[<NoComparison; NoEquality>]
type CodeFixState =
    { PendingEdits: ConcurrentDictionary<int, WorkspaceEdit>
      mutable NextId: int }

/// Create a new code fix state for caching pending edits.
let createState () : CodeFixState =
    { PendingEdits = ConcurrentDictionary<int, WorkspaceEdit>()
      NextId = 0 }

// ── Helpers ──────────────────────────────────────────────────────

/// Extract 0-based positions from an FCS diagnostic range (1-based lines).
let private diagPositions (diag: FSharpDiagnostic) =
    let r = diag.Range
    let startLine = r.StartLine - 1
    let startCol = r.StartColumn
    let endLine = r.EndLine - 1
    let endCol = r.EndColumn
    (startLine, startCol, endLine, endCol)

/// Allocate a unique action ID (thread-safe).
let private nextId (state: CodeFixState) =
    Interlocked.Increment(&state.NextId)

/// Cache a workspace edit and return a CodeActionItem.
let private cacheAction
    (state: CodeFixState)
    (title: string)
    (kind: string)
    (isPreferred: bool)
    (edit: WorkspaceEdit)
    : CodeActionItem =
    let id = nextId state
    state.PendingEdits[id] <- edit
    { Id = id
      Title = title
      Kind = kind
      IsPreferred = isPreferred }

/// Build a single-file workspace edit.
let private singleFileEdit (filePath: string) (edits: TextEdit list) : WorkspaceEdit =
    { DocumentChanges = [ { FilePath = filePath; Edits = edits } ] }

/// Check if a diagnostic's range overlaps with the requested range.
let private overlapsRange
    (diagStartLine: int) (diagEndLine: int)
    (reqStartLine: int) (reqEndLine: int)
    : bool =
    diagStartLine <= reqEndLine && diagEndLine >= reqStartLine

// ── Individual Fix Providers ─────────────────────────────────────

let private namespaceForUndefinedName =
    function
    | "Path" | "File" | "Directory" -> Some "System.IO"
    | "Task" -> Some "System.Threading.Tasks"
    | "Regex" -> Some "System.Text.RegularExpressions"
    | "Dictionary" -> Some "System.Collections.Generic"
    | _ -> None

let private isOpenHeaderLine (line: string) =
    let trimmed = line.TrimStart()
    String.IsNullOrWhiteSpace(trimmed)
    || trimmed.StartsWith("module ", StringComparison.Ordinal)
    || trimmed.StartsWith("namespace ", StringComparison.Ordinal)
    || trimmed.StartsWith("open ", StringComparison.Ordinal)
    || trimmed.StartsWith("#", StringComparison.Ordinal)
    || trimmed.StartsWith("//", StringComparison.Ordinal)

let private openInsertionLine (source: string) =
    let lines = source.Split('\n')
    lines
    |> Array.tryFindIndex (isOpenHeaderLine >> not)
    |> Option.defaultValue lines.Length

/// FS0039: "The value or constructor 'X' is not defined."
/// Suggests adding an open declaration for known namespaces.
let private tryFixUndefinedName
    (state: CodeFixState)
    (filePath: string)
    (source: string)
    (diag: FSharpDiagnostic)
    : CodeActionItem list =
    let msg = diag.Message
    let nameMatch = Regex.Match(msg, @"'([^']+)'")
    if not nameMatch.Success then []
    else
        let name = nameMatch.Groups[1].Value
        namespaceForUndefinedName name
        |> Option.toList
        |> List.map (fun namespaceName ->
            let insertionLine = openInsertionLine source
            let edit =
                singleFileEdit filePath
                    [ { StartLine = insertionLine; StartCharacter = 0
                        EndLine = insertionLine; EndCharacter = 0
                        NewText = $"open {namespaceName}\n" } ]
            cacheAction state $"Add 'open {namespaceName}'" "quickfix" false edit)

/// FS1182: "The value 'X' is unused."
/// Suggests prefixing the binding name with _.
let private tryFixUnusedValue
    (state: CodeFixState)
    (filePath: string)
    (_source: string)
    (diag: FSharpDiagnostic)
    : CodeActionItem list =
    let nameMatch = Regex.Match(diag.Message, @"'([^']+)'")
    if not nameMatch.Success then []
    else
        let name = nameMatch.Groups[1].Value
        let (line, col, _, _) = diagPositions diag
        let edit =
            singleFileEdit filePath
                [ { StartLine = line; StartCharacter = col
                    EndLine = line; EndCharacter = col + name.Length
                    NewText = $"_{name}" } ]
        [ cacheAction state $"Prefix '{name}' with _" "quickfix" true edit ]

/// FS0020: "The result of this expression has type X and is implicitly ignored."
/// Suggests adding |> ignore.
let private tryFixImplicitlyIgnored
    (state: CodeFixState)
    (filePath: string)
    (_source: string)
    (diag: FSharpDiagnostic)
    : CodeActionItem list =
    let (_, _, endLine, endCol) = diagPositions diag
    let edit =
        singleFileEdit filePath
            [ { StartLine = endLine; StartCharacter = endCol
                EndLine = endLine; EndCharacter = endCol
                NewText = " |> ignore" } ]
    [ cacheAction state "Add '|> ignore'" "quickfix" true edit ]

/// FS0025: "Incomplete pattern matches on this expression."
/// Suggests adding a wildcard catch-all case.
let private tryFixIncompleteMatch
    (state: CodeFixState)
    (filePath: string)
    (source: string)
    (diag: FSharpDiagnostic)
    : CodeActionItem list =
    let lines = source.Split('\n')
    let (matchLine, _, _, _) = diagPositions diag
    let matchIndent = lines[matchLine].Length - lines[matchLine].TrimStart().Length
    let mutable lastCaseLine = matchLine
    let mutable line = matchLine + 1
    let mutable insideMatch = true
    while insideMatch && line < lines.Length do
        let current = lines[line]
        let trimmed = current.TrimStart()
        if trimmed.StartsWith("| ") then
            lastCaseLine <- line
        elif not (String.IsNullOrWhiteSpace current)
             && current.Length - trimmed.Length <= matchIndent then
            insideMatch <- false
        line <- line + 1
    let indent =
        if lastCaseLine < lines.Length then
            let caseLine = lines[lastCaseLine]
            let pipeIdx = caseLine.IndexOf('|')
            if pipeIdx >= 0 then String.replicate pipeIdx " " else "    "
        else "    "
    let insertLine = lastCaseLine + 1
    let edit =
        singleFileEdit filePath
            [ { StartLine = insertLine; StartCharacter = 0
                EndLine = insertLine; EndCharacter = 0
                NewText = $"{indent}| _ -> failwith \"Unhandled case\"\n" } ]
    [ cacheAction state "Add wildcard case '| _ ->'" "quickfix" false edit ]

/// FS0026: "This rule will never be matched."
/// Suggests removing the redundant pattern case.
let private tryFixRedundantCase
    (state: CodeFixState)
    (filePath: string)
    (_source: string)
    (diag: FSharpDiagnostic)
    : CodeActionItem list =
    let (startLine, _, endLine, _) = diagPositions diag
    let edit =
        singleFileEdit filePath
            [ { StartLine = startLine; StartCharacter = 0
                EndLine = endLine + 1; EndCharacter = 0
                NewText = "" } ]
    [ cacheAction state "Remove redundant pattern case" "quickfix" false edit ]

let private conversionFunction = function
    | "float", "int"
    | "float", "decimal" -> Some "float"
    | "int", "float" -> Some "int"
    | "string", _ -> Some "string"
    | "float32", "float" -> Some "float32"
    | "float", "float32" -> Some "float"
    | "int64", "int"
    | "int64", "float" -> Some "int64"
    | "int", "int64" -> Some "int"
    | _ -> None

let private mismatchTypes message =
    let found = Regex.Match(message, @"type\s+'([^']+)'\s+but\s+here\s+has\s+type\s+'([^']+)'")
    if found.Success then Some(found.Groups[1].Value, found.Groups[2].Value) else None

let private diagnosticExpression (source: string) (diag: FSharpDiagnostic) =
    let startLine, startCol, endLine, endCol = diagPositions diag
    let lines = source.Split('\n')
    if startLine <> endLine || startLine >= lines.Length then None
    else
        let expression = lines[startLine].Substring(startCol, endCol - startCol)
        if expression = "" then None
        else Some(startLine, startCol, endLine, endCol, expression)

let private conversionAction state filePath expected conversion details =
    let startLine, startCol, endLine, endCol, expression = details
    let edit =
        singleFileEdit filePath
            [ { StartLine = startLine; StartCharacter = startCol
                EndLine = endLine; EndCharacter = endCol
                NewText = $"({conversion} {expression})" } ]
    cacheAction state $"Convert to {expected} using '{conversion}'" "quickfix" false edit

/// FS0001: suggest an explicit conversion when FCS reports a supported primitive mismatch.
let private tryFixTypeMismatch state filePath source (diag: FSharpDiagnostic) =
    match mismatchTypes diag.Message, diagnosticExpression source diag with
    | Some(expected, actual), Some details ->
        match conversionFunction (expected, actual) with
        | Some conversion -> [ conversionAction state filePath expected conversion details ]
        | None -> []
    | _ -> []

// ── Main Entry Points ────────────────────────────────────────────

/// Dispatch a diagnostic to the appropriate fix provider.
let private getFixesForDiagnostic
    (state: CodeFixState)
    (filePath: string)
    (source: string)
    (diag: FSharpDiagnostic)
    : CodeActionItem list =
    match diag.ErrorNumber with
    | 20 -> tryFixImplicitlyIgnored state filePath source diag
    | 25 -> tryFixIncompleteMatch state filePath source diag
    | 26 -> tryFixRedundantCase state filePath source diag
    | 39 -> tryFixUndefinedName state filePath source diag
    // FS0001 is the type-mismatch diagnostic ("expected type X but has type Y").
    | 1 -> tryFixTypeMismatch state filePath source diag
    | 1182 -> tryFixUnusedValue state filePath source diag
    | _ -> []

/// Wrap a GeneratedAction from FSharpCodeActions into a cached CodeActionItem.
let private wrapGeneratedAction
    (state: CodeFixState)
    (action: FSharpCodeActions.GeneratedAction)
    : CodeActionItem =
    let edit =
        { DocumentChanges =
            action.Edits
            |> List.groupBy (fun e -> e.FilePath)
            |> List.map (fun (fp, edits) ->
                { FilePath = fp
                  Edits =
                    edits
                    |> List.map (fun e ->
                        { StartLine = e.StartLine
                          StartCharacter = e.StartCharacter
                          EndLine = e.EndLine
                          EndCharacter = e.EndCharacter
                          NewText = e.NewText }) }) }
    cacheAction state action.Title action.Kind action.IsPreferred edit

/// Collect type-informed code actions (union stubs, record stubs).
let private collectTypeInformedActions
    (state: CodeFixState)
    (filePath: string)
    (source: string)
    (checkResults: FSharpCheckFileResults)
    (parseResults: FSharpParseFileResults)
    (startLine: int)
    (startChar: int)
    : CodeActionItem list =
    let mutable actions = []
    match FSharpCodeActions.tryGenerateUnionStubs checkResults parseResults source filePath startLine startChar with
    | Some action -> actions <- wrapGeneratedAction state action :: actions
    | None -> ()
    match FSharpCodeActions.tryGenerateRecordStubs checkResults parseResults source filePath startLine startChar with
    | Some action -> actions <- wrapGeneratedAction state action :: actions
    | None -> ()
    actions |> List.rev

// ── Analyzer-driven fixes (FSAC parity) ──────────────────────────

/// [ANALYZERS-FSAC-CODEFIX-UNUSED-OPEN] "Remove unused open" for each unused `open` range that
/// overlaps the requested range. Deletes the whole `open` line (start of its first
/// line through the start of the line after its last), mirroring FSAC's behaviour.
let private removeUnusedOpenActions
    (state: CodeFixState)
    (filePath: string)
    (unusedOpens: range list)
    (startLine: int)
    (endLine: int)
    : CodeActionItem list =
    unusedOpens
    |> List.filter (fun r -> overlapsRange (r.StartLine - 1) (r.EndLine - 1) startLine endLine)
    |> List.map (fun r ->
        let edit =
            singleFileEdit
                filePath
                [ { StartLine = r.StartLine - 1
                    StartCharacter = 0
                    EndLine = r.EndLine
                    EndCharacter = 0
                    NewText = "" } ]

        cacheAction state "Remove unused open" "quickfix" false edit)

/// [ANALYZERS-FSAC-CODEFIX-SIMPLIFY-NAME] "Simplify name" for each redundant qualifier that
/// overlaps the requested range. FCS reports `Range` as the unnecessary qualifier
/// prefix (including its trailing dot), so simplification deletes that span,
/// e.g. `System.DateTime.MinValue` → `DateTime.MinValue` when `System` is open.
let private simplifyNameActions
    (state: CodeFixState)
    (filePath: string)
    (names: (range * string) list)
    (startLine: int)
    (endLine: int)
    : CodeActionItem list =
    names
    |> List.filter (fun (r, _) -> overlapsRange (r.StartLine - 1) (r.EndLine - 1) startLine endLine)
    |> List.map (fun (r, _relativeName) ->
        let edit =
            singleFileEdit
                filePath
                [ { StartLine = r.StartLine - 1
                    StartCharacter = r.StartColumn
                    EndLine = r.EndLine - 1
                    EndCharacter = r.EndColumn
                    NewText = "" } ]

        cacheAction state "Simplify name" "quickfix" false edit)

/// Collect analyzer-driven fixes (unused-open removal, name simplification) from
/// the shared [FSharpLocalAnalysis] findings, so the always-on diagnostic hints
/// and these fixes are always computed from the same FCS results.
let private collectAnalyzerActions
    (state: CodeFixState)
    (filePath: string)
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (startLine: int)
    (endLine: int)
    : Async<CodeActionItem list> =
    async {
        let! findings = FSharpLocalAnalysis.getFileAnalyzerFindings checkResults source

        return
            removeUnusedOpenActions state filePath findings.UnusedOpens startLine endLine
            @ simplifyNameActions state filePath findings.SimplifiableNames startLine endLine
    }

let private diagnosticActions state filePath source startLine endLine (diagnostics: FSharpDiagnostic array) =
    diagnostics
    |> Array.filter (fun diagnostic ->
        let range = diagnostic.Range
        overlapsRange (range.StartLine - 1) (range.EndLine - 1) startLine endLine)
    |> Array.toList
    |> List.collect (getFixesForDiagnostic state filePath source)

let private interfaceActions
    state filePath source
    (checkResults: FSharpCheckFileResults)
    (parseResults: FSharpParseFileResults)
    line character =
    async {
        let! generated =
            FSharpCodeActions.tryGenerateInterfaceStub
                checkResults parseResults source filePath line character
        return generated |> Option.map (wrapGeneratedAction state >> List.singleton) |> Option.defaultValue []
    }

let private collectCodeActions
    state filePath source parseResults (checkResults: FSharpCheckFileResults)
    startLine startCharacter endLine =
    task {
        let diagnostics = diagnosticActions state filePath source startLine endLine checkResults.Diagnostics
        let typed =
            collectTypeInformedActions
                state filePath source checkResults parseResults startLine startCharacter
        let! analyzed = collectAnalyzerActions state filePath checkResults source startLine endLine
        let! interfaces =
            interfaceActions state filePath source checkResults parseResults startLine startCharacter
        return diagnostics @ typed @ analyzed @ interfaces
    }

let private getCodeActionsCore state workspace filePath startLine startCharacter endLine =
    task {
        try
            let! checkedFile = FSharpWorkspace.checkFileWithParse workspace filePath
            match checkedFile with
            | None -> return []
            | Some(parseResults, checkResults, source) ->
                return!
                    collectCodeActions
                        state filePath source parseResults checkResults
                        startLine startCharacter endLine
        with ex ->
            Log.Debug(ex, "[F# CodeFixes] failed")
            return []
    }

/// Get all code actions for a file range.
let getCodeActions
    (state: CodeFixState)
    (workspace: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (startLine: int)
    (startCharacter: int)
    (endLine: int)
    (_endCharacter: int)
    =
    getCodeActionsCore state workspace filePath startLine startCharacter endLine

/// Resolve a cached code action by ID.
let resolveCodeAction (state: CodeFixState) (actionId: int) : WorkspaceEdit option =
    match state.PendingEdits.TryRemove(actionId) with
    | true, edit -> Some edit
    | false, _ -> None
