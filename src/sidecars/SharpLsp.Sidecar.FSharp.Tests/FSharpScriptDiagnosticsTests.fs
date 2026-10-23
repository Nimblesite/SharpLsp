/// Real compiler IPC script snapshots. [SCRIPT-FSX-DIAGNOSTICS] [HOVER-FSHARP-OVERLAY]
module SharpLsp.Sidecar.FSharp.Tests.FSharpScriptDiagnosticsTests

open System.IO
open System.Threading.Tasks
open System.Xml.Linq
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpDiagnosticsDocumentsTests

type ScriptDiagnosticTests(fixture: EngineDiagnosticsFixture) =
    let script = NativePaths.Resolve(fixture.Dir, "Main.fsx")
    let child = NativePaths.Resolve(fixture.Dir, "Child.fsx")
    let missing = "#r \"missing-script-reference.dll\"\nlet answer = 42\n"
    let clean = "let answer = 42\n"
    let loaded = "#load \"Child.fsx\"\nlet answer = Child.answer + 1\n"

    interface IClassFixture<EngineDiagnosticsFixture>

    member private _.Open(source: string) = task {
        File.WriteAllText(script, source)
        let! response = fixture.SendFor("workspace/open", script)
        Assert.Null(response.Error)
    }

    member private _.Change(path, source) = task {
        let! response = fixture.DidChange(path, source)
        Assert.Null(response.Error)
    }

    member private _.Errors(path: string, code: string option) = task {
        let! diagnostics = fixture.Diagnostics(path)
        let errors = diagnostics |> Array.filter (fun item -> item.Severity = "Error")
        match code with
        | None -> Assert.Empty(errors)
        | Some expected ->
            let diagnostic = Assert.Single(errors)
            Assert.Equal(expected, diagnostic.Code)
            Assert.True(NativePaths.AreEqual(path, diagnostic.FilePath))
            Assert.True(diagnostic.StartLine >= 0 && diagnostic.EndLine >= diagnostic.StartLine)
            Assert.False(System.String.IsNullOrWhiteSpace(diagnostic.Message))
    }

    member private _.Sources(expected: string array, absent: string array) = task {
        let! documents = fixture.Documents()
        for path in expected do
            Assert.Contains(documents, fun document -> NativePaths.AreEqual(path, document.FilePath))
        for path in absent do
            Assert.DoesNotContain(documents, fun document -> NativePaths.AreEqual(path, document.FilePath))
        Assert.Equal(documents.Length, documents |> Array.distinctBy _.FilePath |> Array.length)
    }

    interface IAsyncLifetime with
        member _.InitializeAsync() = Task.CompletedTask
        member _.DisposeAsync() = task {
            for path in [ script; child ] do
                let! closed = fixture.DidClose(path)
                Assert.Null(closed.Error)
            let! response = fixture.SendFor("workspace/open", fixture.Project)
            Assert.Null(response.Error)
        }

    [<Fact>]
    member this.``script setup errors clear and return with the first compiler IPC snapshot``() = task {
        do! this.Open(missing)
        do! this.Errors(script, Some "FS0078")
        do! this.Sources([| script |], [||])
        do! this.Change(script, clean)
        do! this.Errors(script, None)
        do! this.Change(script, missing)
        do! this.Errors(script, Some "FS0078")
    }

    [<Fact>]
    member this.``script load membership follows edits and keeps child errors at the child``() = task {
        File.WriteAllText(child, "let answer = 41\n")
        do! this.Open(loaded)
        do! this.Errors(script, None)
        do! this.Sources([| script; child |], [||])
        do! this.Change(child, "let answer: int = \"broken\"\n")
        do! this.Errors(child, Some "FS0001")
        do! this.Change(script, clean)
        do! this.Errors(script, None)
        do! this.Sources([| script |], [| child |])
    }

    [<Fact>]
    member this.``unselected script diagnostics use the live overlay and didClose restores disk``() = task {
        File.WriteAllText(script, clean)
        do! this.Errors(script, None)
        do! this.Change(script, "let answer: int = \"broken\"\n")
        do! this.Errors(script, Some "FS0001")
        let! response = fixture.DidClose(script)
        Assert.Null(response.Error)
        do! this.Errors(script, None)
        do! this.Sources([| fixture.Valid; fixture.Extra; fixture.Hints |], [| script |])
    }

/// Compiler setup failures belong to the project, separately from source metadata.
/// [DIAG-CATEGORIES-COMPILER] [DIAG-ARCHITECTURE-EAGER-SCAN]
type ProjectDiagnosticTests(fixture: EngineDiagnosticsFixture) =
    interface IClassFixture<EngineDiagnosticsFixture>

    member private _.Reference(enabled: bool) =
        let document = XDocument.Load(fixture.Project)
        let root = Assert.IsType<XElement>(document.Root)
        let flags = document.Descendants(XName.Get "OtherFlags") |> Seq.toArray
        for flag in flags do flag.Remove()
        if enabled then
            let reference = "--reference:" + NativePaths.Resolve(fixture.Dir, "Missing.dll")
            root.Add(XElement(XName.Get "PropertyGroup", XElement(XName.Get "OtherFlags", reference)))
        document.Save(fixture.Project)

    member private this.Load(enabled: bool) = task {
        this.Reference(enabled)
        let! response = fixture.SendFor("workspace/open", fixture.Project)
        Assert.Null(response.Error)
    }

    member private _.Report(broken: bool) = task {
        let! diagnostics = fixture.Diagnostics(fixture.Project, project = true)
        let errors = diagnostics |> Array.filter (fun diagnostic -> diagnostic.Severity = "Error")
        if not broken then Assert.Empty(errors)
        else
            let diagnostic = Assert.Single(errors)
            // FCS startup uses FS0084; the SDK command-line resolver uses FS0078.
            Assert.Equal("FS0084", diagnostic.Code)
            Assert.True(NativePaths.AreEqual(fixture.Project, diagnostic.FilePath))
            Assert.Equal((0, 0, 0, 0), (diagnostic.StartLine, diagnostic.StartCharacter, diagnostic.EndLine, diagnostic.EndCharacter))
    }

    interface IAsyncLifetime with
        member _.InitializeAsync() = Task.CompletedTask
        member this.DisposeAsync() = this.Load(false) :> Task

    [<Fact>]
    member this.``global reference errors repair and regress at the owning project through real IPC``() = task {
        do! this.Load(true)
        do! this.Report(true)
        do! this.Load(false)
        do! this.Report(false)
        do! this.Load(true)
        do! this.Report(true)
    }

    [<Fact>]
    member _.``project metadata remains distinct and an unknown compiler owner is an error``() = task {
        let! sources = fixture.Documents()
        let! projects = fixture.Documents(projects = true)
        let project = Assert.Single(projects)
        Assert.Equal("TestProject", project.ProjectName)
        Assert.True(NativePaths.AreEqual(fixture.Project, project.FilePath))
        Assert.DoesNotContain(sources, fun document -> NativePaths.AreEqual(fixture.Project, document.FilePath))
        let! response = fixture.SendFor("workspace/diagnostics/project", NativePaths.Resolve(fixture.Dir, "Unloaded.fsproj"))
        Assert.NotNull(response.Error)
        Assert.Empty(response.Payload)
    }
