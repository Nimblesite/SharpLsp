/// `codeAction/fixAll` over the sidecar's real IPC socket ([FIXALL-SCOPES], GitHub
/// #577): an applied fix-all is one wire workspace edit; a refused one is an IPC
/// error carrying its reason in plain words, never an empty edit. [REFACTOR-NEVER-SILENT]
module SharpLsp.Sidecar.FSharp.Tests.FSharpFixAllIpcTests

open MessagePack
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.SidecarEndToEndTests

let private request file fixKey scope =
    MessagePackSerializer.Serialize(
        { FixAllRequest.FilePath = file
          FixKey = fixKey
          Scope = scope }
    )

type FSharpFixAllIpcTests(fixture: SidecarFixture) =
    interface IClassFixture<SidecarFixture>

    [<Fact>]
    member _.``fix-all over IPC returns one workspace edit and refuses with its reason``() =
        task {
            // Interaction 1 — document scope deletes Hints.fs's one unused open, line 2.
            let! applied = fixture.Send("codeAction/fixAll", request fixture.Hints "SLSPF0102" "document")
            Assert.Null(applied.Error)
            let edit = deserialize<WorkspaceEditResult> applied.Payload
            let document = Assert.Single(edit.DocumentChanges)
            Assert.Equal(fixture.Hints, document.FilePath)
            let deletion = Assert.Single(document.Edits)
            Assert.Equal(2, deletion.StartLine)
            Assert.Equal(0, deletion.StartCharacter)
            Assert.Equal("", deletion.NewText)

            // Interaction 2 — project scope still reaches Hints.fs, and never edits
            // Simplify.fs, whose `open System` is used.
            let! project = fixture.Send("codeAction/fixAll", request fixture.Hints "SLSPF0102" "project")
            Assert.Null(project.Error)
            let files =
                (deserialize<WorkspaceEditResult> project.Payload).DocumentChanges
                |> Array.map _.FilePath

            Assert.Contains(fixture.Hints, files)
            Assert.DoesNotContain(fixture.Simplify, files)

            // Interaction 3 — an unknown key refuses, naming the key.
            let! unknown = fixture.Send("codeAction/fixAll", request fixture.Hints "NOT-A-FIX" "document")
            Assert.NotNull(unknown.Error)
            Assert.Contains("NOT-A-FIX", unknown.Error)

            // Interaction 4 — a file with nothing to fix refuses rather than return an empty edit.
            let! nothing = fixture.Send("codeAction/fixAll", request fixture.Dead "SLSPF0102" "document")
            Assert.NotNull(nothing.Error)
            Assert.Contains("no occurrences", nothing.Error)

            // Interaction 5 — solution scope spans at least the project's edits, and an
            // unknown scope refuses, naming it.
            let! solution = fixture.Send("codeAction/fixAll", request fixture.Hints "SLSPF0102" "solution")
            Assert.Null(solution.Error)
            let solutionFiles = (deserialize<WorkspaceEditResult> solution.Payload).DocumentChanges
            Assert.True(solutionFiles.Length >= files.Length, "solution scope contains project scope")
            let! universe = fixture.Send("codeAction/fixAll", request fixture.Hints "SLSPF0102" "universe")
            Assert.NotNull(universe.Error)
            Assert.Contains("universe", universe.Error)

            // Interaction 6 — with the analyzers on, the dead-declaration fix-all deletes
            // Dead.fs's never-used private function, and only within Dead.fs.
            let! dead = fixture.Send("codeAction/fixAll", request fixture.Dead "SLSPF0101" "document")
            Assert.Null(dead.Error)
            let deadDocument = Assert.Single((deserialize<WorkspaceEditResult> dead.Payload).DocumentChanges)
            Assert.Equal(fixture.Dead, deadDocument.FilePath)
            Assert.NotEmpty(deadDocument.Edits)
            Assert.All(deadDocument.Edits, fun e -> Assert.Equal("", e.NewText))

            // Interaction 7 — an undeserializable payload is an error, never a crash,
            // and the sidecar keeps answering after each.
            for meth in [ "codeAction/fixAll"; "textDocument/didClose"; "diagnostics/configure"; "analyzers/configure" ] do
                let! garbage = fixture.Send(meth, [| 0xC1uy |])
                Assert.False(isNull garbage.Error, $"{meth} rejects a malformed payload")

            let! again = fixture.Send("codeAction/fixAll", request fixture.Hints "SLSPF0102" "document")
            Assert.Null(again.Error)
        }
