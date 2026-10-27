/// FCS's implicit root reads share the source already supplied to script resolution.
/// Implements [SCRIPT-FSX-OPTIONS] and [DIAG-ANALYSIS-CANCELLATION].
module internal SharpLsp.Sidecar.FSharp.FSharpScriptSource

open System
open System.IO
open System.Text
open System.Threading
open FSharp.Compiler.IO
open SharpLsp.Sidecar.Common

// Request-local input references, never retained compiler results or an overlay store.
let private snapshot = AsyncLocal<(string * string) option>()

type private SnapshotFileSystem() =
    inherit DefaultFileSystem()
    override _.OpenFileForReadShim(filePath, ?useMemoryMappedFile, ?shouldShadowCopy) =
        match snapshot.Value with
        | Some(root, source) when NativePaths.AreEqual(root, filePath) ->
            new MemoryStream(Encoding.UTF8.GetBytes(source), false) :> Stream
        | _ ->
            base.OpenFileForReadShim(filePath, ?useMemoryMappedFile = useMemoryMappedFile,
                                    ?shouldShadowCopy = shouldShadowCopy)

let private installed = lazy (FileSystem <- SnapshotFileSystem())

/// Async execution inherits only this request's root text and restores its caller's scope.
let enter filePath source =
    installed.Force()
    let previous = snapshot.Value
    snapshot.Value <- Some(filePath, source)
    { new IDisposable with member _.Dispose() = snapshot.Value <- previous }
