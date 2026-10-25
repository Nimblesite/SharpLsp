/// Single source for the pinned archive identity and all path validation.
module LintSourceBuild.SourcePaths

open System
open System.IO

/// Single discriminated failure type for the whole tool.
type PrepError =
    { Code: string
      Message: string }

let err code message = { Code = code; Message = message }

/// Version of this tool, recorded in fingerprints and provenance.
[<Literal>]
let ToolVersion = "2.0.0"

/// Exact upstream FSharpLint revision this tool is pinned to.
[<Literal>]
let PinnedRevision = "d2607f5c68fe0e8c0366e815692cb8d314e254a3"

/// SHA-256 of the pinned upstream archive (lowercase hex).
[<Literal>]
let PinnedArchiveSha256 = "054e41159b63e3da77dd6f079d40b386d399075f214c9687654215da38f01ff8"

/// Upstream source file that receives the AST compatibility rewrite,
/// relative to the archive's single top-level directory.
[<Literal>]
let RewriteTargetRelative = "src/FSharpLint.Core/Rules/NamingHelper.fs"

/// Name of the fingerprint file stored inside the destination directory.
[<Literal>]
let FingerprintName = ".lint-source-build.fingerprint.json"

/// Name of the provenance file stored inside the destination directory.
[<Literal>]
let ProvenanceName = "PROVENANCE.md"

let requireAbsoluteFile (kind: string) (path: string) : Result<string, PrepError> =
    let isFullRooted = Path.IsPathFullyQualified path
    if String.IsNullOrWhiteSpace path then Error(err "empty-path" (kind + " path is empty"))
    elif not isFullRooted then Error(err "relative-path" (kind + " path must be absolute: " + path))
    elif not (File.Exists path) then Error(err "missing-path" (kind + " does not exist: " + path))
    else Ok(Path.GetFullPath path)

let requireAbsoluteDirectory (kind: string) (path: string) : Result<string, PrepError> =
    let isFullRooted = Path.IsPathFullyQualified path
    if String.IsNullOrWhiteSpace path then Error(err "empty-path" (kind + " path is empty"))
    elif not isFullRooted then Error(err "relative-path" (kind + " path must be absolute: " + path))
    else
        try
            Ok(Path.GetFullPath path)
        with e ->
            Error(err "invalid-path" (kind + " could not be normalized: " + e.Message))

/// Validate a single archive entry name and map it under the destination root.
/// Rejects absolute paths, drive specs, ".." segments, and any escaping of the root.
let validateEntryPath (destRoot: string) (entryName: string) : Result<string, PrepError> =
    let bad why = err "unsafe-entry" (sprintf "entry rejected (%s): %s" why entryName)
    if String.IsNullOrWhiteSpace entryName then Error(bad "empty name")
    else
        let trimmed = entryName
        if entryName.Contains ":" || Path.IsPathRooted trimmed || trimmed.StartsWith "/" || trimmed.StartsWith "\\" then
            Error(bad "rooted or drive-qualified")
        else
            let segments = trimmed.Replace('\\', '/').Split('/')
            if Array.exists (fun s -> s = "..") segments then Error(bad "traversal")
            elif trimmed.Contains "//" || trimmed = "/" then Error(bad "empty segment")
            else
                let normalizedRoot = Path.GetFullPath(destRoot).TrimEnd(Path.DirectorySeparatorChar)
                let combined = Path.GetFullPath(Path.Combine(destRoot, trimmed))
                let rootWithSep = normalizedRoot + string Path.DirectorySeparatorChar
                if not (combined.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase)) then
                    Error(bad "escapes destination root")
                else Ok combined

/// Filesystem operations are centralized for this independent build-tool tier.
let resolve (root: string) (relative: string) = Path.GetFullPath(Path.Combine(root, relative))
let fingerprintPath root = resolve root FingerprintName
let sourceRelative () = "FSharpLint-" + PinnedRevision + "/" + RewriteTargetRelative
let sourcePath root = resolve root (sourceRelative ())
let ruleStatePath root = resolve root ("FSharpLint-" + PinnedRevision + "/src/FSharpLint.Core/Rules/Conventions/CyclomaticComplexity.fs")
let provenancePath root = resolve root ProvenanceName
let archiveName (archive: string) = Path.GetFileName archive
let entryRoot (entryName: string) = entryName.Replace('\\', '/').Split('/') |> Array.tryHead |> Option.defaultValue ""
let ensureParent (path: string) =
    match Path.GetDirectoryName path with
    | null -> ()
    | parent -> Directory.CreateDirectory parent |> ignore

/// Deterministic assembly identity invalidates prepared sources when the builder changes.
let toolIdentity () = typeof<PrepError>.Module.ModuleVersionId.ToString("D")
