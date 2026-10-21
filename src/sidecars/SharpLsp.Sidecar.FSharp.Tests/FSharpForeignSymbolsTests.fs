/// The F# side of a symbol C# or Razor names by identity, its assembly and XML doc
/// signature: where F# declares it and every F# use, searched only in the project that
/// builds its assembly and the projects reading that one. Implements [RAZOR-TESTING] for
/// [DEFINITION-CROSSLANG-IDENTITY] and [REFERENCES-CROSS-LANGUAGE].
module SharpLsp.Sidecar.FSharp.Tests.FSharpForeignSymbolsTests

open Xunit
open FSharp.Compiler.Symbols
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests
open SharpLsp.Sidecar.Common

let private DOMAIN =
    source
        [ "namespace Domain"
          ""
          "type Player = { Name: string; Score: int }"
          ""
          "module Scoring ="
          "    let total (players: seq<Player>) = players |> Seq.sumBy (fun player -> player.Score)"
          "    let best (players: seq<Player>) = players |> Seq.maxBy (fun player -> player.Score)" ]

let private BOARD =
    source
        [ "module Board"
          "open Domain"
          "let ada = { Name = \"Ada\"; Score = 3 }"
          "let points = ada.Score + Scoring.total [ ada ]" ]

/// A symbol of the test project's assembly, as C# names it.
let private named xmlDocSig : FSharpForeignSymbols.SymbolIdentity =
    { AssemblyName = "TestProject"; XmlDocSig = xmlDocSig }

let private placed (locations: FSharpWorkspace.DefinitionLocation list) =
    locations
    |> List.map (fun location -> string (NativePaths.NameOf location.FilePath), location.Line, location.Character)
    |> List.sort

let private domain () = loadWorkspace [ "Domain.fs", DOMAIN; "Board.fs", BOARD ]

[<Fact>]
let ``declarations place a type, a record field and a function where F# declares them`` () = task {
    let! (state, dir, _, _) = domain ()
    try
        let! player = FSharpForeignSymbols.declarations state (named "T:Domain.Player") true
        Assert.Equal<(string * int * int) list>([ "Domain.fs", 2, 5 ], placed player)
        let! score = FSharpForeignSymbols.declarations state (named "P:Domain.Player.Score") true
        Assert.Equal<(string * int * int) list>([ "Domain.fs", 2, 30 ], placed score)
        let total = "M:Domain.Scoring.total(System.Collections.Generic.IEnumerable{Domain.Player})"
        let! declared = FSharpForeignSymbols.declarations state (named total) false
        Assert.Equal<(string * int * int) list>([ "Domain.fs", 5, 8 ], placed declared)
        let range = List.exactlyOne declared
        Assert.Equal((5, 13), (range.EndLine, range.EndCharacter))

        // Another assembly's symbol, an unknown one and an empty identity have no F# declaration.
        let elsewhere = { named "T:Domain.Player" with AssemblyName = "Elsewhere" }
        let! foreign = FSharpForeignSymbols.declarations state elsewhere true
        Assert.Empty(foreign)
        let! missing = FSharpForeignSymbols.declarations state (named "T:Domain.Missing") true
        Assert.Empty(missing)
        let! empty = FSharpForeignSymbols.declarations state (named "") true
        Assert.Empty(empty)
    finally
        cleanup dir
}

[<Fact>]
let ``uses list every F# use, with the declaration only when asked`` () = task {
    let! (state, dir, _, _) = domain ()
    try
        let uses = [ "Domain.fs", 5, 82; "Domain.fs", 6, 81; "Board.fs", 2, 26; "Board.fs", 3, 17 ]
        let! withDeclaration = FSharpForeignSymbols.uses state (named "P:Domain.Player.Score") true
        Assert.Equal<(string * int * int) list>(List.sort (("Domain.fs", 2, 30) :: uses), placed withDeclaration)
        let! withoutDeclaration = FSharpForeignSymbols.uses state (named "P:Domain.Player.Score") false
        Assert.Equal<(string * int * int) list>(List.sort uses, placed withoutDeclaration)

        // The type's uses: each annotation; the function's: its one call.
        let! player = FSharpForeignSymbols.uses state (named "T:Domain.Player") false
        Assert.Equal<(string * int * int) list>([ "Domain.fs", 5, 28; "Domain.fs", 6, 27 ], placed player)
        let total = "M:Domain.Scoring.total(System.Collections.Generic.IEnumerable{Domain.Player})"
        let! called = FSharpForeignSymbols.uses state (named total) false
        Assert.Equal<(string * int * int) list>([ "Board.fs", 3, 33 ], placed called)
    finally
        cleanup dir
}

[<Fact>]
let ``an unloaded workspace has no declarations or uses`` () = task {
    let state = FSharpWorkspace.create ()
    let! declared = FSharpForeignSymbols.declarations state (named "T:Domain.Player") true
    Assert.Empty(declared)
    let! used = FSharpForeignSymbols.uses state (named "T:Domain.Player") true
    Assert.Empty(used)
    Assert.Empty(FSharpForeignSymbols.scopeOf state "TestProject")
}

/// F#'s own references and a foreign request agree: each use is placed on its name, never
/// on the whole dotted path FCS ranges it over (`ada.Score`). [REFERENCES-FSHARP-FIND]
[<Fact>]
let ``F# references and foreign uses place each use on its name alike`` () = task {
    let! (state, dir, _, paths) = domain ()
    try
        let! own = FSharpReferences.getReferences state paths[0] 2 30 true
        let! foreign = FSharpForeignSymbols.uses state (named "P:Domain.Player.Score") true
        Assert.Equal<(string * int * int) list>(placed foreign, placed own)
        let ends = own |> List.map (fun location -> location.EndCharacter - location.Character) |> List.distinct
        Assert.Equal<int list>([ "Score".Length ], ends)

        // From a use, too: the dotted `ada.Score` in Board.fs.
        let! fromUse = FSharpReferences.getReferences state paths[1] 3 18 false
        Assert.Equal<(string * int * int) list>(
            [ "Board.fs", 2, 26; "Board.fs", 3, 17; "Domain.fs", 5, 82; "Domain.fs", 6, 81 ],
            placed fromUse
        )
    finally
        cleanup dir
}

let private MARKS =
    source
        [ "module Marks"
          ""
          "type MarkAttribute() ="
          "    inherit System.Attribute()"
          ""
          "[<Mark>]"
          "let marked (value: 'T) = value" ]

/// An attribute used by its short name (`[<Mark>]` for `MarkAttribute`) has no token that
/// spells its symbol, so its use keeps FCS's range; a type parameter has no XML doc signature,
/// so C# can never name it. [REFERENCES-FSHARP-FIND] [DEFINITION-CROSSLANG-IDENTITY]
[<Fact>]
let ``a use no token spells keeps its range, and a symbol without a signature has no identity`` () = task {
    let! (state, dir, _, paths) = loadWorkspace [ "Marks.fs", MARKS ]
    try
        let! fileCheck = FSharpWorkspace.checkFile state paths[0]
        let checkResults, _ = FSharpForeignSymbols.requireCheckedFile paths[0] fileCheck
        let uses = checkResults.GetAllUsesOfAllSymbolsInFile() |> Seq.toArray
        let tokenized = FSharpRenameToken.tokenizeSource state.Checker (FSharpWorkspace.readSource state paths[0])

        let mark =
            uses
            |> Array.find (fun symbolUse ->
                let range = symbolUse.Range
                range.StartLine = 6 && range.StartColumn = 2)
        Assert.Equal((5, 2, 5, 6), FSharpReferences.nameSpan state.Checker tokenized mark)

        let typeParameter = uses |> Array.find (fun symbolUse -> symbolUse.Symbol :? FSharpGenericParameter)
        Assert.True((FSharpForeignSymbols.identityOf typeParameter.Symbol).IsNone, "a type parameter")
        let declared =
            uses |> Array.find (fun symbolUse -> symbolUse.Symbol :? FSharpEntity && symbolUse.IsFromDefinition)
        let identity = FSharpForeignSymbols.identityOf declared.Symbol
        Assert.Equal(Some "T:Marks.MarkAttribute", identity |> Option.map (fun named -> named.XmlDocSig))
    finally
        cleanup dir
}
