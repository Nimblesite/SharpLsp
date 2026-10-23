/// Real SDK restoration through compiler IPC. [DIAG-RESTORE] [DIAG-IPC-INITIALIZED]
module SharpLsp.Sidecar.FSharp.Tests.FSharpWorkspaceRestoreEndToEndTests

open System
open System.IO
open System.Xml.Linq
open MessagePack
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.FSharp.Tests.FSharpDiagnosticsDocumentsTests

type WorkspaceRestoreTests(fixture: EngineDiagnosticsFixture) =
    let assets = NativePaths.Resolve(fixture.Dir, "obj", "project.assets.json")
    let marker = NativePaths.Resolve(fixture.Dir, "restore.marker")

    interface IClassFixture<EngineDiagnosticsFixture>

    member private _.Configure(enabled: bool, refresh: bool) = task {
        let request = DiagnosticsConfiguration(AnalyzersEnabled = false, RefreshSupported = refresh,
                                              AutoRestoreOnOpen = Nullable(enabled))
        let! response = fixture.Send("diagnostics/configure", MessagePackSerializer.Serialize(request))
        Assert.Null(response.Error)
    }

    member private _.Completions =
        fixture.Notifications
        |> Array.filter (fun item -> item.Method = "workspace/initializationComplete")
        |> Array.length

    member private this.Open(succeeds: bool, announces: bool) = task {
        let before = this.Completions
        let! response = fixture.SendFor("workspace/open", fixture.Project)
        if succeeds then Assert.Null(response.Error)
        else Assert.Contains("Package restore failed", response.Error)
        Assert.Equal(before + (if announces then 1 else 0), this.Completions)
        let! ping = fixture.Send("ping", [||])
        Assert.Null(ping.Error)
    }

    member private _.Build() =
        FSharpDesignTimeTests.dotnet fixture.Dir $"build \"{fixture.Project}\" --nologo --disable-build-servers"

    member private _.CleanCompiler() = task {
        let! diagnostics = fixture.Diagnostics(fixture.Valid)
        Assert.DoesNotContain(diagnostics, fun item -> item.Severity = "Error")
        let! documents = fixture.Documents()
        Assert.Contains(documents, fun item -> NativePaths.AreEqual(item.FilePath, fixture.Valid))
        Assert.Contains(documents, fun item -> NativePaths.AreEqual(item.FilePath, fixture.Extra))
    }

    member private _.PrepareProject() =
        let document = XDocument.Load(fixture.Project)
        let root = Assert.IsType<XElement>(document.Root)
        document.Descendants(XName.Get "DisableImplicitFSharpCoreReference")
        |> Seq.iter (fun property -> property.Value <- "false")
        let writer = XElement(XName.Get "WriteLinesToFile",
                              XAttribute(XName.Get "File", marker),
                              XAttribute(XName.Get "Lines", "restored"))
        root.Add(XElement(XName.Get "Target", XAttribute(XName.Get "Name", "RecordRestore"),
                                   XAttribute(XName.Get "BeforeTargets", "Restore"), writer))
        document.Save(fixture.Project)

    member private _.SetRestoreFailure(fails: bool) =
        let document = XDocument.Load(fixture.Project)
        let root = Assert.IsType<XElement>(document.Root)
        if fails then
            root.Add(XElement(XName.Get "Target", XAttribute(XName.Get "Name", "FailRestore"),
                                       XAttribute(XName.Get "BeforeTargets", "Restore"),
                                       XElement(XName.Get "Error", XAttribute(XName.Get "Text", "intentional fixture restore failure"))))
        else
            document.Descendants(XName.Get "Target")
            |> Seq.filter (fun target -> target.Attribute(XName.Get "Name") |> Option.ofObj
                                        |> Option.exists (fun name -> name.Value = "FailRestore"))
            |> Seq.toArray |> Array.iter _.Remove()
        document.Save(fixture.Project)

    member private _.RemoveAssets() =
        File.Delete(assets)
        File.Delete(marker)
        Assert.False(File.Exists(assets))
        Assert.False(File.Exists(marker))

    member private this.RestoreMissing() = task {
        this.RemoveAssets()
        do! this.Configure(false, true)
        do! this.Open(true, true)
        Assert.False(File.Exists(assets))
        Assert.False(File.Exists(marker))
        do! this.Configure(true, true)
        do! this.Open(true, true)
        Assert.True(File.Exists(assets))
        Assert.Equal("restored", File.ReadAllText(marker).Trim())
        this.Build()
        do! this.CleanCompiler()
    }

    member private this.RestoreInvalidAssets(contents: string) = task {
        File.Delete(marker)
        File.WriteAllText(assets, contents)
        do! this.Open(true, true)
        Assert.True(FileInfo(assets).Length > int64 contents.Length)
        Assert.True(File.Exists(marker))
        this.Build()
        do! this.CleanCompiler()
    }

    member private this.RecoverFailedRestore() = task {
        this.SetRestoreFailure(true)
        this.RemoveAssets()
        do! this.Open(false, false)
        Assert.False(File.Exists(assets))
        Assert.True(File.Exists(marker))
        this.SetRestoreFailure(false)
        do! this.Open(true, true)
        Assert.True(File.Exists(assets))
        this.Build()
        do! this.CleanCompiler()
    }

    [<Fact>]
    member this.``workspace open restores real SDK inputs and recovers without restarting the compiler``() = task {
        this.PrepareProject()
        this.Build()
        do! this.Configure(true, true)
        do! this.Open(true, true)
        do! this.CleanCompiler()
        do! this.RestoreMissing()
        do! this.RestoreInvalidAssets("{")
        do! this.RestoreInvalidAssets("{}")
        do! this.RecoverFailedRestore()
        do! this.Configure(true, false)
        do! this.Open(true, false)
        do! this.CleanCompiler()
    }
