/// Structured fingerprints preserve timestamps on a verified no-op build.
/// Implements [DIAG-CATEGORIES-ANALYZER].
module LintSourceBuild.Incremental

open System.IO
open System.Text.Json
open LintSourceBuild.Archive
open LintSourceBuild.SourcePaths

type Fingerprint =
    { ToolVersion: string; ToolIdentity: string; ArchiveSha256: string
      Revision: string; TargetRelative: string; TargetSha256: string; RuleStateSha256: string }

let private options = JsonSerializerOptions(PropertyNamingPolicy = JsonNamingPolicy.CamelCase)

let write root (fingerprint: Fingerprint) =
    try
        File.WriteAllBytes(fingerprintPath root, JsonSerializer.SerializeToUtf8Bytes(fingerprint, options))
        Ok ()
    with error -> Error(err "fingerprint-write-failed" (error.GetType().Name))

/// Read JSON through the parser, including ordinary compact JSON and escaped values.
let private field name (root: JsonElement) =
    match root.TryGetProperty(name: string) with
    | true, value when value.ValueKind = JsonValueKind.String -> value.GetString() |> Option.ofObj
    | _ -> None

let private matches root archiveSha (document: JsonDocument) =
    let value name = field name document.RootElement
    value "toolVersion" = Some ToolVersion
    && value "toolIdentity" = Some(toolIdentity ())
    && value "archiveSha256" = Some archiveSha
    && value "revision" = Some PinnedRevision
    && value "targetRelative" = Some(sourceRelative ())
    && File.Exists(sourcePath root)
    && File.Exists(ruleStatePath root)

let isUpToDate root archiveSha =
    try
        if not (File.Exists(fingerprintPath root)) then Ok false
        else
            use document = JsonDocument.Parse(File.ReadAllBytes(fingerprintPath root))
            if not (matches root archiveSha document) then Ok false
            else
                sha256File (sourcePath root) |> Result.bind (fun hash ->
                    sha256File (ruleStatePath root) |> Result.map (fun stateHash ->
                        field "targetSha256" document.RootElement = Some hash
                        && field "ruleStateSha256" document.RootElement = Some stateHash))
    with _ -> Ok false

let build archiveSha relative targetSha stateSha =
    { ToolVersion = ToolVersion; ToolIdentity = toolIdentity (); ArchiveSha256 = archiveSha
      Revision = PinnedRevision; TargetRelative = relative; TargetSha256 = targetSha; RuleStateSha256 = stateSha }
