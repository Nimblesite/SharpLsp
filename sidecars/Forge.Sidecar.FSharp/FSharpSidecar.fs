/// F# sidecar: hosts FSharp.Compiler.Service.
/// Registers handlers for workspace loading, hover, etc.
namespace Forge.Sidecar.FSharp

open System
open System.Threading
open System.Threading.Tasks
open Forge.Sidecar.Common
open MessagePack
open Outcome

type ByteResult = Result<byte[], string>

[<MessagePackObject(AllowPrivate = true)>]
type PositionRequest =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] Line: int
      [<Key(2)>] Character: int }

[<MessagePackObject(AllowPrivate = true)>]
type HoverResult =
    { [<Key(0)>] Contents: string
      [<Key(1)>] StartLine: Nullable<int>
      [<Key(2)>] StartCharacter: Nullable<int>
      [<Key(3)>] EndLine: Nullable<int>
      [<Key(4)>] EndCharacter: Nullable<int> }

type FSharpSidecar() =
    inherit SidecarHost()

    let workspace = FSharpWorkspace.create ()

    do
        base.Register("workspace/open", fun payload ct -> FSharpSidecar.HandleOpenAsync(workspace, payload, ct))
        base.Register("workspace/status", fun payload ct -> FSharpSidecar.HandleStatusAsync(workspace, payload, ct))
        base.Register("textDocument/hover", fun payload ct -> FSharpSidecar.HandleHoverAsync(workspace, payload, ct))

    static member private HandleOpenAsync
        (workspace: FSharpWorkspace.FSharpWorkspaceState, payload: byte[], ct: CancellationToken)
        : Task<ByteResult> =
        task {
            try
                let path = MessagePackSerializer.Deserialize<string>(payload, cancellationToken = ct)
                let! result = FSharpWorkspace.loadProject workspace path
                match result with
                | Ok () ->
                    let bytes = MessagePackSerializer.Serialize("ok", cancellationToken = ct)
                    return Result<byte[], string>.Ok(bytes) :> ByteResult
                | Error msg ->
                    return ByteResult.Failure(msg)
            with ex ->
                return ByteResult.Failure(ex.Message)
        }

    static member private HandleStatusAsync
        (workspace: FSharpWorkspace.FSharpWorkspaceState, _payload: byte[], ct: CancellationToken)
        : Task<ByteResult> =
        try
            let status = if workspace.IsLoaded then "loaded" else "not_loaded"
            let bytes = MessagePackSerializer.Serialize(status, cancellationToken = ct)
            Task.FromResult<ByteResult>(Result<byte[], string>.Ok(bytes))
        with ex ->
            Task.FromResult<ByteResult>(ByteResult.Failure(ex.Message))

    static member private HandleHoverAsync
        (workspace: FSharpWorkspace.FSharpWorkspaceState, payload: byte[], ct: CancellationToken)
        : Task<ByteResult> =
        task {
            try
                let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                let! hover = FSharpWorkspace.getHover workspace request.FilePath request.Line request.Character
                match hover with
                | Some (markdown, sl, sc, el, ec) ->
                    let result =
                        { Contents = markdown
                          StartLine = Nullable sl
                          StartCharacter = Nullable sc
                          EndLine = Nullable el
                          EndCharacter = Nullable ec }
                    let bytes = MessagePackSerializer.Serialize(result, cancellationToken = ct)
                    return Result<byte[], string>.Ok(bytes) :> ByteResult
                | None ->
                    let bytes = MessagePackSerializer.Serialize(Nullable<HoverResult>(), cancellationToken = ct)
                    return Result<byte[], string>.Ok(bytes) :> ByteResult
            with ex ->
                return ByteResult.Failure(ex.Message)
        }
