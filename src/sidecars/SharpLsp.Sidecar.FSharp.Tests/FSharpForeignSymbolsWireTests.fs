/// The foreign-symbol requests over the sidecar's real IPC socket: the C# sidecar names an F#
/// symbol by its assembly and XML doc signature, and `workspace/declarationForeign` and
/// `workspace/referencesForeign` answer where F# declares and uses it. Implements
/// [RAZOR-TESTING] for [DEFINITION-CROSSLANG-IDENTITY] and [REFERENCES-CROSS-LANGUAGE].
module SharpLsp.Sidecar.FSharp.Tests.FSharpForeignSymbolsWireTests

open Xunit
open MessagePack
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.Tests.SidecarEndToEndTests

/// The `workspace/*Foreign` request for the fixture project's symbol `xmlDocSig`.
let private request assemblyName xmlDocSig includeDeclaration =
    MessagePackSerializer.Serialize(
        { ForeignSymbolRequest.AssemblyName = assemblyName
          XmlDocSig = xmlDocSig
          IncludeDeclaration = includeDeclaration }
    )

/// Each location as (file name, line, character, end character).
let private placed (result: LocationListResult) =
    result.Locations
    |> Array.map (fun location ->
        string (NativePaths.NameOf location.FilePath), location.Line, location.Character, location.EndCharacter)
    |> Array.sort
    |> List.ofArray

let private ADD = "M:TestProject.Library.add(System.Int32,System.Int32)"

type FSharpForeignSymbolsWireTests(fixture: SidecarFixture) =
    interface IClassFixture<SidecarFixture>

    [<Fact>]
    member _.``a foreign declaration request lands on the F# declaration``() = task {
        let! person = fixture.Send("workspace/declarationForeign", request "TestProject" "T:TestProject.Library.Person" true)
        Assert.Null(person.Error)
        Assert.Equal<(string * int * int * int) list>(
            [ "Library.fs", 9, 5, 11 ],
            placed (deserialize<LocationListResult> person.Payload)
        )

        // A function is named with its parameter types, and lands on its name.
        let! add = fixture.Send("workspace/declarationForeign", request "TestProject" ADD false)
        Assert.Null(add.Error)
        Assert.Equal<(string * int * int * int) list>(
            [ "Library.fs", 6, 4, 7 ],
            placed (deserialize<LocationListResult> add.Payload)
        )

        // Another assembly's symbol of the same name has no F# declaration here.
        let! elsewhere = fixture.Send("workspace/declarationForeign", request "Elsewhere" "T:TestProject.Library.Person" true)
        Assert.Null(elsewhere.Error)
        Assert.Empty((deserialize<LocationListResult> elsewhere.Payload).Locations)
    }

    [<Fact>]
    member _.``a foreign references request lists F# uses, the declaration only when asked``() = task {
        let! withDeclaration = fixture.Send("workspace/referencesForeign", request "TestProject" ADD true)
        Assert.Null(withDeclaration.Error)
        let all = placed (deserialize<LocationListResult> withDeclaration.Payload)
        Assert.Contains(("Library.fs", 6, 4, 7), all)
        Assert.Contains(("Library.fs", 15, 13, 16), all)

        let! withoutDeclaration = fixture.Send("workspace/referencesForeign", request "TestProject" ADD false)
        Assert.Null(withoutDeclaration.Error)
        let uses = placed (deserialize<LocationListResult> withoutDeclaration.Payload)
        Assert.DoesNotContain(("Library.fs", 6, 4, 7), uses)
        Assert.Equal<(string * int * int * int) list>(List.except [ "Library.fs", 6, 4, 7 ] all, uses)
        Assert.All(uses, fun (_, _, character, endCharacter) -> Assert.Equal("add".Length, endCharacter - character))

        // A symbol F# does not declare has no uses.
        let! missing = fixture.Send("workspace/referencesForeign", request "TestProject" "T:TestProject.Library.Missing" true)
        Assert.Null(missing.Error)
        Assert.Empty((deserialize<LocationListResult> missing.Payload).Locations)
    }
