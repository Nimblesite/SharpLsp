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

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type LocationResult =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] Line: int
      [<Key(2)>] Character: int
      [<Key(3)>] EndLine: int
      [<Key(4)>] EndCharacter: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type LocationListResult =
    { [<Key(0)>] Locations: LocationResult array }

module private Helpers =
    /// Convert a FSharpWorkspace.DefinitionLocation to a LocationResult.
    let toLocationResult (loc: FSharpWorkspace.DefinitionLocation) : LocationResult =
        { FilePath = loc.FilePath
          Line = loc.Line
          Character = loc.Character
          EndLine = loc.EndLine
          EndCharacter = loc.EndCharacter }

    /// Serialize a value to a successful ByteResult.
    let serializeOk<'T> (value: 'T) (ct: CancellationToken) : ByteResult =
        let bytes = MessagePackSerializer.Serialize(value, cancellationToken = ct)
        Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult

    /// Build a location handler for workspace methods returning a single optional location.
    let locationOptionHandler
        (workspace: FSharpWorkspace.FSharpWorkspaceState)
        (getLocation: FSharpWorkspace.FSharpWorkspaceState -> string -> int -> int -> Task<FSharpWorkspace.DefinitionLocation option>)
        : Func<byte[], CancellationToken, Task<ByteResult>> =
        Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! result = getLocation workspace request.FilePath request.Line request.Character
                    match result with
                    | Some loc ->
                        return serializeOk { Locations = [| toLocationResult loc |] } ct
                    | None ->
                        return serializeOk { Locations = [||] } ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            })

    /// Build a location handler for workspace methods returning a list of locations.
    let locationListHandler
        (workspace: FSharpWorkspace.FSharpWorkspaceState)
        (getLocations: FSharpWorkspace.FSharpWorkspaceState -> string -> int -> int -> Task<FSharpWorkspace.DefinitionLocation list>)
        : Func<byte[], CancellationToken, Task<ByteResult>> =
        Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! results = getLocations workspace request.FilePath request.Line request.Character
                    let locations = results |> List.map toLocationResult |> Array.ofList
                    return serializeOk { Locations = locations } ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            })

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
                        return Helpers.serializeOk "ok" ct
                    | Error msg ->
                        return ByteResult.Failure(msg)
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        base.Register("workspace/status", Func<byte[], CancellationToken, Task<ByteResult>>(fun _payload ct ->
            try
                let status = if workspace.IsLoaded then "loaded" else "not_loaded"
                Task.FromResult<ByteResult>(Helpers.serializeOk status ct)
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
                        return Helpers.serializeOk result ct
                    | None ->
                        // Return MessagePack nil (0xC0) for no hover result.
                        let bytes = [| 0xC0uy |]
                        return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        base.Register("textDocument/definition", Helpers.locationOptionHandler workspace FSharpWorkspace.getDefinition)
        base.Register("textDocument/typeDefinition", Helpers.locationOptionHandler workspace FSharpWorkspace.getTypeDefinition)
        base.Register("textDocument/declaration", Helpers.locationOptionHandler workspace FSharpWorkspace.getDeclaration)
        base.Register("textDocument/implementation", Helpers.locationListHandler workspace FSharpWorkspace.getImplementations)
