/// FSharpLint integration: runs lint analysis on F# files and returns diagnostics.
module SharpLsp.Sidecar.FSharp.FSharpLinting

open System.IO
open FSharpLint.Application
open Serilog

/// A lint diagnostic matching the sidecar wire format.
type LintDiagnostic =
    { FilePath: string
      StartLine: int
      StartCharacter: int
      EndLine: int
      EndCharacter: int
      Message: string
      Severity: string
      Code: string }

/// Run FSharpLint on a single file and return lint diagnostics.
let lintFile (filePath: string) : LintDiagnostic list =
    try
        if not (File.Exists(filePath)) then []
        else
            let parameters =
                { Lint.OptionalLintParameters.Default with
                    Configuration = Lint.ConfigurationParam.Default }
            let result = Lint.lintFile parameters filePath
            match result with
            | LintResult.Success warnings ->
                warnings
                |> List.map (fun w ->
                    let r = w.Details.Range
                    { FilePath = filePath
                      StartLine = r.StartLine - 1
                      StartCharacter = r.StartColumn
                      EndLine = r.EndLine - 1
                      EndCharacter = r.EndColumn
                      Message = w.Details.Message
                      Severity = "Warning"
                      Code = w.RuleIdentifier })
            | LintResult.Failure failure ->
                Log.Debug("[FSharpLint] failure: {Description}", failure.Description)
                []
    with ex ->
        Log.Debug(ex, "[FSharpLint] failed")
        []

/// Run FSharpLint on all F# source files in a project directory.
let lintProject (projectDir: string) : Map<string, LintDiagnostic list> =
    try
        let fsFiles =
            Directory.GetFiles(projectDir, "*.fs", SearchOption.AllDirectories)
            |> Array.filter (fun f ->
                not (f.Contains("obj") || f.Contains("bin")))
        fsFiles
        |> Array.map (fun f -> f, lintFile f)
        |> Array.filter (fun (_, diags) -> not diags.IsEmpty)
        |> Map.ofArray
    with ex ->
        Log.Debug(ex, "[FSharpLint] project lint failed")
        Map.empty
