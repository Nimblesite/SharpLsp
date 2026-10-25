/// Tool entry point: prepare pinned upstream FSharpLint source for compilation.
///
/// Usage: lint-source-build <absolute-archive.tar.gz> <absolute-destination-dir>
///
/// Behavior: verify the pinned archive hash, extract it safely into the
/// destination, apply the AST compatibility rewrite to NamingHelper.fs, write
/// provenance + fingerprint, and print a single JSON result to stdout.
/// Exit code 0 on success or no-op, 1 on any failure (with an error JSON).
module LintSourceBuild.Program

open System
open System.IO
open LintSourceBuild.Archive
open LintSourceBuild.AstRewrite
open LintSourceBuild.Incremental
open LintSourceBuild.Json
open LintSourceBuild.SourcePaths

let private emit (pairs: (string * obj) array) : int =
    use output = Console.OpenStandardOutput()
    output.Write(System.Text.Encoding.UTF8.GetBytes(writeObject pairs))
    0

let private failOut (e: PrepError) : int =
    emit [| "status", "error"; "code", e.Code; "error", e.Message |] |> ignore
    1

/// Fail closed unless the archive hash matches the pinned value.
let private checkPinned (sha: string) : Result<string, PrepError> =
    if String.Compare(sha, PinnedArchiveSha256, StringComparison.OrdinalIgnoreCase) = 0 then Ok sha
    else Error(err "hash-mismatch" (sprintf "archive SHA-256 %s does not match pinned %s" sha PinnedArchiveSha256))

/// Provenance is plain markdown written next to the extracted source; it never
/// contains source contents, only identity facts.
let private writeProvenance (destination: string) (archiveFile: string) (sha: string) : Result<unit, PrepError> =
    let text =
        "This directory contains source extracted from the official FSharpLint upstream archive.\n\n"
        + "- Upstream revision: " + PinnedRevision + "\n"
        + "- Archive file: " + archiveName archiveFile + "\n"
        + "- Archive SHA-256: " + sha + "\n"
        + "- Extracted with: lint-source-build " + ToolVersion + " (BCL tar/gzip reader; no shell)\n"
        + "- License: see LICENSE in the extracted upstream root directory.\n"
        + "- AST compatibility rewrite applied to: " + RewriteTargetRelative
        + " (two BasicQualifiedName match patterns wrapped in Some; verified by re-parse).\n"
        + "- Rule state correction: CyclomaticComplexity cleanup releases the captured threshold after every run.\n"
    try
        File.WriteAllText(provenancePath destination, text)
        Ok()
    with e ->
        Error(err "provenance-failed" e.Message)

let private finish destination archiveFile sha targetRelative targetPath fileCount : Result<int, PrepError> =
    sha256File targetPath
    |> Result.bind (fun targetSha ->
        sha256File (ruleStatePath destination)
        |> Result.bind (fun stateSha ->
            writeProvenance destination archiveFile sha
            |> Result.bind (fun () -> Incremental.write destination (Incremental.build sha targetRelative targetSha stateSha)))
        |> Result.map (fun () ->
            emit
                [| "status", "ok"
                   "archiveSha256", sha
                   "revision", PinnedRevision
                   "destination", destination
                   "filesExtracted", fileCount
                   "rewrittenFile", targetRelative
                   "wrappedPatterns", 2
                   "resetRuleState", 1 |]))

let private buildFresh archiveFile destination sha : Result<int, PrepError> =
    extract archiveFile destination
    |> Result.bind (fun (fileCount, _) ->
        let targetRelative = sourceRelative ()
        let targetPath = sourcePath destination
        if not (File.Exists targetPath) then
            Error(err "target-missing" ("expected rewritten source not found in archive: " + targetRelative))
        else
            rewriteFile targetPath
            |> Result.bind (fun () -> rewriteRuleState (ruleStatePath destination))
            |> Result.bind (fun () -> finish destination archiveFile sha targetRelative targetPath fileCount))

let private prepare archiveFile destination sha : Result<int, PrepError> =
    isUpToDate destination sha
    |> Result.bind (fun upToDate ->
        if upToDate then
            Ok(emit [| "status", "noop"; "archiveSha256", sha; "destination", destination |])
        else buildFresh archiveFile destination sha)

[<EntryPoint>]
let main (argv: string array) : int =
    match argv with
    | [| archive; destination |] ->
        (requireAbsoluteFile "archive" archive
         |> Result.bind (fun a -> requireAbsoluteDirectory "destination" destination |> Result.map (fun d -> a, d))
         |> Result.bind (fun (a, d) -> sha256File a |> Result.map (fun sha -> a, d, sha))
         |> Result.bind (fun (a, d, sha) -> checkPinned sha |> Result.map (fun s -> a, d, s))
         |> Result.bind (fun (a, d, s) -> prepare a d s))
        |> function
            | Ok code -> code
            | Error e -> failOut e
    | _ ->
        failOut (err "usage" "usage: lint-source-build <archive.tar.gz> <destination-dir>")
