/// F# sidecar: hosts FSharp.Compiler.Service.
/// Registers handlers for workspace loading, hover, etc.
namespace Forge.Sidecar.FSharp

open System
open System.Threading
open System.Threading.Tasks
open Forge.Sidecar.Common
open MessagePack

type ByteResult = Outcome.Result<byte[], string>

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type PositionRequest =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] Line: int
      [<Key(2)>] Character: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
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
        base.Register("workspace/open", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let path = MessagePackSerializer.Deserialize<string>(payload, cancellationToken = ct)
                    let! result = FSharpWorkspace.loadProject workspace path
                    match result with
                    | Ok () ->
                        let bytes = MessagePackSerializer.Serialize("ok", cancellationToken = ct)
                        return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                    | Error msg ->
                        return ByteResult.Failure(msg)
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        base.Register("workspace/status", Func<byte[], CancellationToken, Task<ByteResult>>(fun _payload ct ->
            try
                let status = if workspace.IsLoaded then "loaded" else "not_loaded"
                let bytes = MessagePackSerializer.Serialize(status, cancellationToken = ct)
                Task.FromResult<ByteResult>(Outcome.Result<byte[], string>.Ok<byte[], string>(bytes))
            with ex ->
                Task.FromResult<ByteResult>(ByteResult.Failure(ex.Message))))

        base.Register("textDocument/hover", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
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
                        return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                    | None ->
                        // Return nil (no hover)
                        let bytes = MessagePackSerializer.Serialize<HoverResult option>(None, cancellationToken = ct)
                        return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))
