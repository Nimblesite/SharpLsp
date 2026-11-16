/// Navigation on type-provider symbols through the real F# compiler and a real
/// provider (FSharp.Data's JsonProvider, restored from NuGet). A provided type
/// and its members have no source: definition lands on the declaration that
/// instantiates the provider, never on a file that does not exist.
/// Implements [DEFINITION-FSHARP-PROVIDED].
module SharpLsp.Sidecar.FSharp.Tests.FSharpTypeProviderNavigationTests

open System
open System.IO
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCodeActionKit
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpImportFixTests

let private quotes = "\"\"\""

let private app =
    String.Join(
        "\n",
        [ "module App.Library"
          ""
          "open FSharp.Data"
          ""
          $"type Weather = JsonProvider<{quotes}{{\"city\":\"Oslo\",\"temperature\":4.5}}{quotes}>"
          $"type Person = JsonProvider<{quotes}{{\"name\":\"Ada\"}}{quotes}>"
          ""
          $"let sample = Weather.Parse({quotes}{{\"city\":\"Rome\",\"temperature\":21.0}}{quotes})"
          "let city = sample.City"
          $"let person = Person.Parse({quotes}{{\"name\":\"Bob\"}}{quotes})"
          "let name = person.Name"
          $"let inlined = JsonProvider<{quotes}[1]{quotes}>.GetSamples()"
          "" ])

/// `(line, start, end)` of a definition, which must be in `path`.
let private landing (path: string) (location: FSharpWorkspace.DefinitionLocation option) =
    match location with
    | None -> failwith "no definition"
    | Some found ->
        Assert.Equal(path, found.FilePath)
        Assert.True(File.Exists found.FilePath, "a definition must be a file this machine has")
        found.Line, found.Character, found.EndCharacter

[<Fact>]
let ``provided types and members navigate to the declaration that instantiates their provider`` () =
    task {
        let! state, root =
            loadSolution [ projectXml "App" [] [ "FSharp.Core", "10.1.404"; "FSharp.Data", "6.6.0" ] |> fun (n, x) -> n, x, app ]
        try
            let path = libraryPath root "App"
            let! _, check, _ = checkedFixture state path
            // The provider really ran: every provided member type-checks.
            Assert.Empty(check.Diagnostics |> Array.filter (fun d -> d.Severity = FSharp.Compiler.Diagnostics.FSharpDiagnosticSeverity.Error))
            let definition line column = FSharpWorkspace.getDefinition state path line column
            let weather, person = (4, 5, 12), (5, 5, 11)
            // Interaction 1 — a provided static member and a provided property land on
            // the abbreviation of THEIR provider, not the other one in the file.
            let! parse = definition 7 22
            Assert.Equal(weather, landing path parse)
            let! city = definition 8 20
            Assert.Equal(weather, landing path city)
            let! personParse = definition 9 23
            Assert.Equal(person, landing path personParse)
            let! personName = definition 10 20
            Assert.Equal(person, landing path personName)
            // Interaction 2 — a use of the abbreviation itself lands there too.
            let! weatherUse = definition 7 15
            Assert.Equal(weather, landing path weatherUse)
            let! personUse = definition 9 15
            Assert.Equal(person, landing path personUse)
            // Interaction 3 — the type of a provided value is its provider's declaration.
            let! sampleType = FSharpWorkspace.getTypeDefinition state path 8 13
            Assert.Equal(weather, landing path sampleType)
            let! personType = FSharpWorkspace.getTypeDefinition state path 10 14
            Assert.Equal(person, landing path personType)
            // Interaction 4 — a provider used with no declaration has nowhere in source
            // to land: nothing is answered, never a file that does not exist.
            let! inlined = definition 11 46
            Assert.True(inlined |> Option.forall (fun found -> File.Exists found.FilePath), $"{inlined}")
            let! inlinedProvider = definition 11 18
            Assert.True(inlinedProvider |> Option.forall (fun found -> File.Exists found.FilePath), $"{inlinedProvider}")
            let! unapplied = definition 4 20
            Assert.True(unapplied |> Option.forall (fun found -> File.Exists found.FilePath), $"{unapplied}")
        finally
            cleanup root
    }
