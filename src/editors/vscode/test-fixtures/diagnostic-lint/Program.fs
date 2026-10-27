// Independent real upstream rule execution. [DIAG-CATEGORIES-ANALYZER] [DIAG-TRUTH-GUARANTEES]
module LintOracle

open System
open System.IO
open System.Threading
open System.Text.Json
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open FSharp.Compiler.Text
open FSharpLint.Application

/// One primitive-only finding, independent of SharpLsp's diagnostic mapper.
type Finding = { Code: string; StartLine: int; StartCharacter: int; EndLine: int; EndCharacter: int }
type Reply = { Success: bool; Failure: string; Findings: Finding array }

let private mapWarning (warning: FSharpLint.Framework.Suggestion.LintWarning) =
    let range = warning.Details.Range
    { Code = warning.RuleIdentifier; StartLine = range.StartLine - 1
      StartCharacter = range.StartColumn; EndLine = range.EndLine - 1; EndCharacter = range.EndColumn }

/// Progress failures must fail the oracle even when upstream returns Success [].
let private lint file source parsed checkedFile config ct =
    let mutable failure = None
    let parameters =
        { OptionalLintParameters.Default with
            Configuration = config; CancellationToken = Some ct
            ReportLinterProgress = Some(function
                | ProjectProgress.Failed(_, error) -> failure <- Some(error.GetType().FullName)
                | _ -> ()) }
    let information = { Source = source; Ast = parsed; TypeCheckResults = Some checkedFile; ProjectCheckResults = None }
    match lintParsedFile parameters information file, failure with
    | _, Some reason -> Error reason
    | LintResult.Failure _ , _ -> Error "LintFailure"
    | LintResult.Success warnings, _ -> Ok(warnings |> List.map mapWarning |> Array.ofList)

let private check file source config ct = async {
    let checker = FSharpChecker.Create(keepAssemblyContents = true)
    let text = SourceText.ofString source
    let! options, setup = checker.GetProjectOptionsFromScript(file, text, useSdkRefs = true, assumeDotNetFramework = false)
    let! parsed, answer = checker.ParseAndCheckFileInProject(file, 0, text, options)
    match answer with
    | FSharpCheckFileAnswer.Aborted -> return Error "AbortedTypeCheck"
    | FSharpCheckFileAnswer.Succeeded checkedFile ->
        let errors = Seq.concat [ setup :> seq<_>; parsed.Diagnostics :> seq<_>; checkedFile.Diagnostics :> seq<_> ]
                     |> Seq.exists (fun diagnostic -> diagnostic.Severity = FSharpDiagnosticSeverity.Error)
        return if errors then Error "CompilerErrors" else lint file source parsed.ParseTree checkedFile config ct
}

/// Standard output is the oracle's JSON protocol, never a diagnostic log.
[<EntryPoint>]
let main args =
    let result =
        try
            use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30.0))
            let config = if args.Length > 1 then ConfigurationParam.FromFile args[1] else ConfigurationParam.Default
            check args[0] (File.ReadAllText args[0]) config timeout.Token
            |> fun work -> Async.RunSynchronously(work, cancellationToken = timeout.Token)
        with error -> Error(error.GetType().FullName)
    let reply = match result with
                | Ok findings -> { Success = true; Failure = ""; Findings = findings }
                | Error reason -> { Success = false; Failure = reason; Findings = [||] }
    use output = Console.OpenStandardOutput()
    output.Write(JsonSerializer.SerializeToUtf8Bytes reply)
    if reply.Success then 0 else 1
