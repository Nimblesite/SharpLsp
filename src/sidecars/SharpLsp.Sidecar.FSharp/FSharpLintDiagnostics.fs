/// Real FSharpLint findings from the same current FCS check as compiler diagnostics.
/// Implements [DIAG-CATEGORIES-ANALYZER], [DIAG-TRUTH-GUARANTEES].
module SharpLsp.Sidecar.FSharp.FSharpLintDiagnostics

open System.Threading
open FSharp.Compiler.CodeAnalysis
open FSharpLint.Application
open SharpLsp.Sidecar.Common

/// Upstream rules own mutable process state; concurrent files must not share a run.
let private gate = new SemaphoreSlim(1, 1)

/// A source inherits the closest configuration, independent of process working directory.
let rec private configuration directory =
    if System.String.IsNullOrEmpty directory then
        ConfigurationParam.Configuration FSharpLint.Framework.Configuration.defaultConfiguration
    else
        let candidate = NativePaths.Resolve(directory, FSharpLint.Framework.Configuration.SettingsFileName)
        if System.IO.File.Exists candidate then ConfigurationParam.FromFile candidate
        else configuration (NativePaths.DirectoryOf directory)

/// Upstream can signal a failed rule and then return Success []; preserve that failure.
let private execute file information config (ct: CancellationToken) =
    let mutable failure = None
    let parameters =
        { OptionalLintParameters.Default with
            Configuration = config; CancellationToken = Some ct
            ReportLinterProgress = Some(function
                | ProjectProgress.Failed(_, error) -> failure <- Some(error.GetType().Name)
                | _ -> ()) }
    ct.ThrowIfCancellationRequested()
    let result = lintParsedFile parameters information file
    ct.ThrowIfCancellationRequested()
    match result, failure with
    | _, Some reason -> Error reason
    | LintResult.Failure _, _ -> Error "F# lint analysis did not complete."
    | LintResult.Success warnings, _ -> Ok warnings

/// A failed analyzer remains visible without discarding fresh compiler findings.
let private failure file (reason: string) =
    Serilog.Log.Warning("F# lint analysis failed: {FailureKind}", reason)
    { FilePath = file; StartLine = 0; StartCharacter = 0; EndLine = 0; EndCharacter = 0
      Message = "F# lint analysis did not complete. Check the lint configuration and SharpLsp output."
      Severity = "Warning"; Code = "SLSPF0104" }

/// Rule identity and source range come directly from FSharpLint, without guessing from text.
let private findings file (parsed: FSharpParseFileResults, checkedFile, source) (ct: CancellationToken) =
    try
        let information =
            { Source = source; Ast = parsed.ParseTree
              TypeCheckResults = Some checkedFile; ProjectCheckResults = None }
        match execute file information (configuration (NativePaths.DirectoryOf file)) ct with
        | Error reason -> [failure file reason]
        | Ok warnings -> warnings |> List.map (fun warning ->
            FSharpAnalyzers.buildDiagnostic warning.RuleIdentifier "Warning" warning.Details.Message warning.Details.Range)
    with error when not ct.IsCancellationRequested -> [failure file (error.GetType().Name)]

/// Cancellation and failed rules must not leak their state into the next source.
let private resetRules () =
    FSharpLint.Rules.CyclomaticComplexity.cleanup ()
    FSharpLint.Rules.NestedStatements.cleanup ()
    FSharpLint.Rules.FailwithBadUsage.cleanup ()

/// Serialize only the stateful linter; compiler checks keep their existing cancellation path.
let get file checkedFile (ct: CancellationToken) =
    task {
        do! gate.WaitAsync ct
        try return findings file checkedFile ct
        finally
            try resetRules ()
            finally gate.Release() |> ignore
    }
