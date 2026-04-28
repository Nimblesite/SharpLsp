module SharpLsp.Sidecar.FSharp.Tests.MessagePackRoundtripTests

open System
open Xunit
open MessagePack
open SharpLsp.Sidecar.FSharp

[<Fact>]
let ``PositionRequest roundtrip`` () =
    let original = { PositionRequest.FilePath = "/src/Lib.fs"; Line = 5; Character = 12 }
    let bytes = MessagePackSerializer.Serialize(original)
    let result = MessagePackSerializer.Deserialize<PositionRequest>(bytes)
    Assert.Equal(original.FilePath, result.FilePath)
    Assert.Equal(original.Line, result.Line)
    Assert.Equal(original.Character, result.Character)

[<Fact>]
let ``HoverResult roundtrip with range`` () =
    let original =
        { HoverResult.Contents = "```fsharp\nlet x = 1\n```"
          StartLine = Nullable 3
          StartCharacter = Nullable 4
          EndLine = Nullable 3
          EndCharacter = Nullable 5 }
    let bytes = MessagePackSerializer.Serialize(original)
    let result = MessagePackSerializer.Deserialize<HoverResult>(bytes)
    Assert.Equal(original.Contents, result.Contents)
    Assert.Equal(Nullable 3, result.StartLine)
    Assert.Equal(Nullable 5, result.EndCharacter)

[<Fact>]
let ``HoverResult roundtrip without range`` () =
    let original =
        { HoverResult.Contents = "hover"
          StartLine = Nullable()
          StartCharacter = Nullable()
          EndLine = Nullable()
          EndCharacter = Nullable() }
    let bytes = MessagePackSerializer.Serialize(original)
    let result = MessagePackSerializer.Deserialize<HoverResult>(bytes)
    Assert.Equal("hover", result.Contents)
    Assert.False(result.StartLine.HasValue)

[<Fact>]
let ``LocationResult roundtrip`` () =
    let original =
        { LocationResult.FilePath = "/src/Lib.fs"
          Line = 10; Character = 4
          EndLine = 10; EndCharacter = 8 }
    let bytes = MessagePackSerializer.Serialize(original)
    let result = MessagePackSerializer.Deserialize<LocationResult>(bytes)
    Assert.Equal("/src/Lib.fs", result.FilePath)
    Assert.Equal(10, result.Line)
    Assert.Equal(8, result.EndCharacter)

[<Fact>]
let ``LocationResult can serialize standalone`` () =
    let original =
        { LocationResult.FilePath = "/a.fs"
          Line = 1; Character = 0; EndLine = 1; EndCharacter = 3 }
    let bytes = MessagePackSerializer.Serialize(original)
    let result = MessagePackSerializer.Deserialize<LocationResult>(bytes)
    Assert.Equal("/a.fs", result.FilePath)
    Assert.Equal(3, result.EndCharacter)

[<Fact>]
let ``FSharpWorkspace create initializes state`` () =
    let state = FSharpWorkspace.create ()
    Assert.False(state.IsLoaded)
    Assert.True(state.ProjectOptions.IsNone)
