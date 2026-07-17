/// F# file ordering analysis: detects dependency violations and suggests reordering.
/// In F#, files must appear in dependency order in the .fsproj — a file cannot
/// reference symbols defined in a file that comes after it in the compile list.
module SharpLsp.Sidecar.FSharp.FSharpFileOrder

open System.IO
open System.Xml.Linq
open FSharp.Compiler.CodeAnalysis
open Serilog

/// A detected file ordering issue.
type FileOrderIssue =
    { /// File that has the unresolved reference.
      FilePath: string
      /// 0-based line of the error.
      Line: int
      /// 0-based column of the error.
      Character: int
      /// The file that defines the missing symbol (comes later in order).
      DependencyFile: string
      /// Human-readable description.
      Message: string }

/// Parse .fsproj Compile entries and return full paths in order.
let getCompileOrder (fsprojPath: string) : string array =
    try
        let doc = XDocument.Load(fsprojPath)
        let projDir = Path.GetDirectoryName(fsprojPath) |> string
        doc.Descendants(XName.Get("Compile"))
        |> Seq.choose (fun el ->
            el.Attribute(XName.Get("Include"))
            |> Option.ofObj
            |> Option.map (fun attr ->
                Path.GetFullPath(Path.Combine(projDir, string attr.Value))))
        |> Seq.toArray
    with ex ->
        Log.Debug(ex, "[F# FileOrder] failed to parse .fsproj")
        [||]

/// Build a map of symbol name → defining file path from check results.
/// Sources come through the overlay so unsaved edits participate in the
/// ordering analysis. [FS-DIDCHANGE-OVERLAY]
let private collectDefinitions
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (options: FSharpProjectOptions)
    (files: string array)
    =
    task {
        let definitions = System.Collections.Generic.Dictionary<string, string>()
        for filePath in files do
            try
                if File.Exists(filePath) then
                    // Canonical overlay-aware check funnel. [FS-DIDCHANGE-OVERLAY]
                    let! _parse, checkAnswer, _source =
                        FSharpWorkspace.parseAndCheckOnce state filePath options
                    match checkAnswer with
                    | FSharpCheckFileAnswer.Succeeded check ->
                        for su in check.GetAllUsesOfAllSymbolsInFile() do
                            if su.IsFromDefinition then
                                definitions[su.Symbol.DisplayName] <- filePath
                    | FSharpCheckFileAnswer.Aborted -> ()
            with _ -> ()
        return definitions
    }

/// Collect undefined symbol errors from FCS check results for a file.
/// Overlay-aware: checks the live buffer text. [FS-DIDCHANGE-OVERLAY]
let private collectUndefinedErrors
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (options: FSharpProjectOptions)
    (filePath: string)
    =
    task {
        try
            if not (File.Exists(filePath)) then
                return []
            else
                // Canonical overlay-aware check funnel. [FS-DIDCHANGE-OVERLAY]
                let! _parseResults, checkAnswer, _source =
                    FSharpWorkspace.parseAndCheckOnce state filePath options
                match checkAnswer with
                | FSharpCheckFileAnswer.Succeeded check ->
                    // FS0039 (value/constructor not defined) and FS0001 are
                    // type-CHECK diagnostics — they live on the check results,
                    // not parseResults.Diagnostics (parse-only), so a forward
                    // dependency was never detected before this fix.
                    let errors =
                        check.Diagnostics
                        |> Array.filter (fun d ->
                            d.ErrorNumber = 39 || d.ErrorNumber = 1)
                        |> Array.map (fun d ->
                            let r = d.Range
                            (r.StartLine - 1, r.StartColumn, d.Message))
                        |> Array.toList
                    return errors
                | FSharpCheckFileAnswer.Aborted -> return []
        with _ -> return []
    }

/// Analyze file ordering and return detected issues.
let analyzeFileOrder
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (fsprojPath: string)
    =
    task {
        try
            if not state.IsLoaded then
                return []
            else
                let files = getCompileOrder fsprojPath
                if files.Length < 2 then return []
                else
                    let options = state.ProjectOptions.Value
                    let! definitions = collectDefinitions state options files
                    let fileIndex =
                        files
                        |> Array.mapi (fun i f -> f, i)
                        |> dict
                    let mutable issues = []
                    for filePath in files do
                        let! errors = collectUndefinedErrors state options filePath
                        // filePath comes straight from `files`, and fileIndex is
                        // built from exactly that array, so the key is always present.
                        let currentIdx = fileIndex[filePath]
                        for (line, char, msg) in errors do
                            // Extract symbol name from error message.
                            let symbolName =
                                msg.Split([| '\'' |])
                                |> Array.tryItem 1
                                |> Option.defaultValue ""
                            match definitions.TryGetValue(symbolName) with
                            | true, defFile when defFile <> filePath ->
                                // defFile is a value from `definitions`, which only
                                // ever stores paths drawn from `files`, so it is
                                // always a key of fileIndex.
                                let defIdx = fileIndex[defFile]
                                if defIdx > currentIdx then
                                    let issue =
                                        { FilePath = filePath
                                          Line = line
                                          Character = char
                                          DependencyFile = defFile
                                          Message =
                                            $"'{symbolName}' is defined in '{Path.GetFileName(defFile)}' which comes after '{Path.GetFileName(filePath)}' in the compile order. Move '{Path.GetFileName(defFile)}' before '{Path.GetFileName(filePath)}' in the .fsproj." }
                                    issues <- issue :: issues
                            | _ -> ()
                    return issues |> List.rev
        with ex ->
            Log.Debug(ex, "[F# FileOrder] failed")
            return []
    }

/// Generate a .fsproj text edit that moves a dependency file before the current file.
let generateReorderEdit
    (fsprojPath: string)
    (dependencyFile: string)
    (beforeFile: string)
    : {| FilePath: string; StartLine: int; StartCharacter: int
         EndLine: int; EndCharacter: int; NewText: string |} option =
    try
        let lines = File.ReadAllLines(fsprojPath)
        let depName = Path.GetFileName(dependencyFile)
        let beforeName = Path.GetFileName(beforeFile)
        let mutable depLineIdx = -1
        let mutable beforeLineIdx = -1
        for i in 0 .. lines.Length - 1 do
            let trimmed = lines[i].Trim()
            if trimmed.Contains($"Include=\"{depName}\"") then depLineIdx <- i
            if trimmed.Contains($"Include=\"{beforeName}\"") then beforeLineIdx <- i
        if depLineIdx >= 0 && beforeLineIdx >= 0 && depLineIdx > beforeLineIdx then
            let depLine = lines[depLineIdx]
            let remaining =
                [| for i in 0 .. lines.Length - 1 do
                    if i <> depLineIdx then yield lines[i] |]
            let insertIdx =
                if depLineIdx < beforeLineIdx then beforeLineIdx - 1
                else beforeLineIdx
            let newLines =
                [| yield! remaining[.. insertIdx - 1]
                   yield depLine
                   yield! remaining[insertIdx ..] |]
            let newText = System.String.Join("\n", newLines)
            Some {| FilePath = fsprojPath
                    StartLine = 0; StartCharacter = 0
                    EndLine = lines.Length - 1
                    EndCharacter = lines[lines.Length - 1].Length
                    NewText = newText |}
        else
            None
    with ex ->
        Log.Debug(ex, "[F# FileOrder] reorder edit failed")
        None
