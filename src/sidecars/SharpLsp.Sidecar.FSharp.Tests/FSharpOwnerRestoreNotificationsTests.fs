/// Real owning-project restoration over idle compiler IPC. [DIAG-IPC-REFRESH] [DIAG-RESTORE]
module SharpLsp.Sidecar.FSharp.Tests.FSharpOwnerRestoreNotificationsTests

open System
open System.IO
open System.Threading
open System.Xml.Linq
open MessagePack
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.FSharp.Tests.FSharpDiagnosticsDocumentsTests

type OwnerRestoreNotificationsTests(fixture: EngineDiagnosticsFixture) =
    let directory = NativePaths.Resolve(fixture.Dir, "Owned")
    let project = NativePaths.Resolve(directory, "Owned.fsproj")
    let entry = NativePaths.Resolve(directory, "Entry.fs")
    let closed = NativePaths.Resolve(directory, "Closed.fs")
    let package = NativePaths.Resolve(directory, "packages", "newtonsoft.json", "13.0.3")
    let source = "module Owned.Entry\nlet length = Newtonsoft.Json.JsonConvert.SerializeObject(42).Length\n"
    let clean = "module Owned.Closed\nlet value: int = 42\n"
    let broken = "module Owned.Closed\nlet value: int = \"broken\"\n"

    interface IClassFixture<EngineDiagnosticsFixture>

    member private _.WriteProject() =
        Directory.CreateDirectory(directory) |> ignore
        let document = XDocument.Load(fixture.Project)
        let root = Assert.IsType<XElement>(document.Root)
        document.Descendants(XName.Get "DisableImplicitFSharpCoreReference")
        |> Seq.iter (fun property -> property.Value <- "false")
        document.Descendants(XName.Get "Compile") |> Seq.toArray |> Array.iter _.Remove()
        root.Add(XElement(XName.Get "PropertyGroup", XElement(XName.Get "RestorePackagesPath", "$(MSBuildProjectDirectory)/packages")))
        let sources = XElement(XName.Get "ItemGroup")
        for name in [ "Entry.fs"; "Closed.fs" ] do
            sources.Add(XElement(XName.Get "Compile", XAttribute(XName.Get "Include", name)))
        sources.Add(XElement(XName.Get "PackageReference", XAttribute(XName.Get "Include", "Newtonsoft.Json"),
                            XAttribute(XName.Get "Version", "13.0.3")))
        root.Add(sources)
        document.Save(project)

    member private this.RemoveActualPackage() =
        this.WriteProject()
        File.WriteAllText(entry, source)
        File.WriteAllText(closed, clean)
        FSharpDesignTimeTests.dotnet directory $"build \"{project}\" --nologo --disable-build-servers"
        Assert.True(File.Exists(NativePaths.Resolve(package, "lib", "net6.0", "Newtonsoft.Json.dll")))
        File.WriteAllText(closed, broken)
        Directory.Delete(package, true)
        Assert.False(Directory.Exists(package))

    member private _.Configure() = task {
        let request = DiagnosticsConfiguration(AnalyzersEnabled = false, RefreshSupported = true)
        let! response = fixture.Send("diagnostics/configure", MessagePackSerializer.Serialize(request))
        Assert.Null(response.Error)
        let! documents = fixture.Documents()
        Assert.DoesNotContain(documents, fun document -> NativePaths.AreEqual(document.ProjectPath, project))
    }

    member private _.AssertCompilerTruth() = task {
        let! diagnostics = fixture.Diagnostics(closed)
        let diagnostic = Assert.Single(diagnostics |> Array.filter (fun item -> item.Severity = "Error"))
        Assert.Equal("FS0001", diagnostic.Code)
        Assert.True(NativePaths.AreEqual(closed, diagnostic.FilePath))
        Assert.Equal(1, diagnostic.StartLine)
        Assert.True(diagnostic.EndCharacter > diagnostic.StartCharacter)
        Assert.False(String.IsNullOrWhiteSpace(diagnostic.Message))
        for path in [ entry; fixture.Valid ] do
            let! valid = fixture.Diagnostics(path)
            Assert.DoesNotContain(valid, fun item -> item.Severity = "Error")
        let! documents = fixture.Documents()
        for path in [ entry; closed ] do
            Assert.Contains(documents, fun document -> NativePaths.AreEqual(document.FilePath, path)
                                                       && NativePaths.AreEqual(document.ProjectPath, project))
    }

    [<Fact>]
    member this.``owner restore emits an idle refresh after didChange acknowledgement without a query rescue``() = task {
        this.RemoveActualPackage()
        do! this.Configure()
        let before = fixture.Notifications.Length
        let! response = fixture.DidChange(entry, source)
        Assert.Null(response.Error)
        Assert.DoesNotContain(fixture.Notifications |> Array.skip before, fun item -> item.Method = "diagnostics/refresh")
        use timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30.0))
        let! notification = fixture.AwaitNotification("diagnostics/refresh", before, timeout.Token)
        Assert.False(notification.Id.HasValue)
        Assert.Equal("diagnostics/refresh", notification.Method)
        Assert.True(Directory.Exists(package))
        do! this.AssertCompilerTruth()
    }
