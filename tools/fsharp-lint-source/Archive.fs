/// Streaming SHA-256 hashing and safe tar.gz extraction.
/// Extraction uses only BCL System.Formats.Tar / GZipStream - never a shell.
module LintSourceBuild.Archive

open System
open System.Formats.Tar
open System.IO
open System.IO.Compression
open System.Security.Cryptography
open LintSourceBuild.SourcePaths

let sha256File (path: string) : Result<string, PrepError> =
    try
        use stream = File.OpenRead(path)
        use hasher = SHA256.Create()
        let hash = hasher.ComputeHash(stream)
        Ok(hash |> Array.map (fun b -> b.ToString("x2")) |> String.concat "")
    with e ->
        Error(err "hash-failed" ("failed to hash " + path + ": " + e.Message))

let private extractFileEntry (entry: TarEntry) (destPath: string) : Result<unit, PrepError> =
    try
        ensureParent destPath
        use target = File.Create(destPath)
        match entry.DataStream with
        | null when entry.Length = 0L -> Ok ()
        | null -> Error(err "missing-stream" "Archive file entry has no content stream.")
        | stream -> stream.CopyTo(target); Ok ()
    with e ->
        Error(err "extract-failed" ("failed to extract " + entry.Name + ": " + e.Message))

let private handleEntry (destRoot: string) (entry: TarEntry) : Result<bool, PrepError> =
    // Returns Ok true when the entry counted as an extracted file.
    match entry.EntryType with
    | TarEntryType.SymbolicLink
    | TarEntryType.HardLink
    | TarEntryType.CharacterDevice
    | TarEntryType.BlockDevice
    | TarEntryType.Fifo ->
        Error(err "link-entry" ("special entries (links/devices/fifos) are not permitted: " + entry.Name))
    | TarEntryType.Directory ->
        validateEntryPath destRoot entry.Name
        |> Result.bind (fun p ->
            try
                Directory.CreateDirectory(p) |> ignore
                Ok false
            with e -> Error(err "mkdir-failed" (entry.Name + ": " + e.Message)))
    | TarEntryType.GlobalExtendedAttributes
    | TarEntryType.ExtendedAttributes ->
        // pax metadata records, not filesystem entries; nothing is written
        Ok false
    | TarEntryType.RegularFile ->
        validateEntryPath destRoot entry.Name
        |> Result.bind (fun p -> extractFileEntry entry p |> Result.map (fun () -> true))
    | other ->
        Error(err "unsupported-entry" (sprintf "entry type %O is not permitted: %s" other entry.Name))

let private sameRoot (known: string option) (entryName: string) : Result<string, PrepError> =
    let seg = entryRoot entryName
    match known with
    | None -> Ok seg
    | Some k when k = seg -> Ok k
    | Some k -> Error(err "multi-root" (sprintf "archive has more than one top-level directory (%s vs %s)" k seg))

let rec private readAll (reader: TarReader) (destRoot: string) (count: int) (root: string option) : Result<int * string, PrepError> =
    match reader.GetNextEntry() with
    | null ->
        match root with
        | None -> Error(err "empty-archive" "archive contains no usable entries")
        | Some r -> Ok(count, r)
    | entry when entry.Name = "pax_global_header" ->
        readAll reader destRoot count root
    | entry ->
        sameRoot root entry.Name
        |> Result.bind (fun r ->
            handleEntry destRoot entry
            |> Result.bind (fun counted -> readAll reader destRoot (if counted then count + 1 else count) (Some r)))

/// Extract the gzip tar archive into destRoot (created if needed).
/// Returns the number of files written and the archive's single top-level
/// directory name (e.g. "FSharpLint-d2607f5...").
let extract (archivePath: string) (destRoot: string) : Result<int * string, PrepError> =
    try
        Directory.CreateDirectory(destRoot) |> ignore
        use file = File.OpenRead(archivePath)
        use gz = new GZipStream(file, CompressionMode.Decompress)
        use reader = new TarReader(gz)
        readAll reader destRoot 0 None
    with e ->
        Error(err "extract-failed" ("failed to read archive " + archivePath + ": " + e.Message))
