/// FS0039 import fixes through the real code-action pipeline over real
/// .fsproj/.slnx fixtures. Every offered edit is resolved, applied exactly,
/// and re-checked by FCS. Implements [REFACTOR-IMPORT-FSHARP],
/// [REFACTOR-IMPORT-REFERENCE] and [REFACTOR-NEVER-SILENT].
module SharpLsp.Sidecar.FSharp.Tests.FSharpImportFixTests

open System
open System.IO
open System.Threading
open FSharp.Compiler.Diagnostics
open FSharp.Compiler.Text
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.Common.References
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCodeActionKit
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests

let private source (lines: string list) = String.Join("\n", Array.ofList lines) + "\n"

let private actionNamed title (actions: FSharpCodeFixes.CodeActionItem list) =
    match actions |> List.filter (fun action -> action.Title = title) with
    | [ action ] -> action
    | _ ->
        let offered = actions |> List.map (fun action -> action.Title) |> String.concat "\n"
        failwith $"expected exactly one '{title}', offered:\n{offered}"

let private referenceOf (action: FSharpCodeFixes.CodeActionItem) =
    action.Reference |> Option.ofObj |> Option.defaultWith (fun () -> failwith "reference action carried no ReferenceImport")

let private applySole state path original title line column =
    task {
        let! fixes, actions = actionsAt state path line column
        let action = actionNamed title actions
        Assert.Equal("quickfix", action.Kind)
        Assert.False(action.IsPreferred)
        let edit = FSharpCodeFixes.resolveCodeAction fixes action.Id |> Option.defaultWith (fun () -> failwith "action did not resolve")
        let document = Assert.Single(edit.DocumentChanges)
        Assert.Equal(path, document.FilePath)
        let change = Assert.Single(document.Edits)
        let edited = applyEdit original change
        match! FSharpWorkspace.checkFileWithSource state path edited Threading.CancellationToken.None with
        | None -> return failwith "FCS did not check the fixed source"
        | Some(_, checkedFile, _) -> return edited, change, checkedFile
    }

let private assertNoErrors (checkedFile: FSharp.Compiler.CodeAnalysis.FSharpCheckFileResults) =
    Assert.Empty(diagnosticsOf FSharpDiagnosticSeverity.Error checkedFile)
    Assert.Empty(linesWith 39 checkedFile)

[<Fact>]
let ``namespace and fully qualified rows have exact explicit titles and clear FS0039`` () =
    task {
        let original = source [ "namespace Shapes"; ""; "module Area ="; "    let joined = Path.Combine(\"a\", \"b\")" ]
        let! state, dir, _, paths = loadWorkspace [ ("Shapes.fs", original) ]
        try
            let! _, before, _ = checkedFixture state paths[0]
            Assert.Equal<int array>([| 3 |], linesWith 39 before)
            let openTitle = "Add 'open System.IO' — imports every type and module in namespace System.IO"
            let qualifyTitle = "Change 'Path' to 'System.IO.Path' — qualifies this one use; no open added"
            let! opened, openEdit, openCheck = applySole state paths[0] original openTitle 3 17
            Assert.Equal("    open System.IO\n", openEdit.NewText)
            Assert.Equal(3, openEdit.StartLine)
            Assert.Equal(source [ "namespace Shapes"; ""; "module Area ="; "    open System.IO"; "    let joined = Path.Combine(\"a\", \"b\")" ], opened)
            assertNoErrors openCheck
            let! qualified, qualifyEdit, qualifyCheck = applySole state paths[0] original qualifyTitle 3 17
            Assert.Equal("System.IO.Path", qualifyEdit.NewText)
            Assert.Equal(3, qualifyEdit.StartLine)
            Assert.Equal(17, qualifyEdit.StartCharacter)
            Assert.Equal(source [ "namespace Shapes"; ""; "module Area ="; "    let joined = System.IO.Path.Combine(\"a\", \"b\")" ], qualified)
            assertNoErrors qualifyCheck
        finally
            cleanup dir
    }

[<Fact>]
let ``AutoOpen and RequireQualifiedAccess entities can qualify this one use`` () =
    task {
        let declarations =
            source
                [ "namespace Special"
                  ""
                  "[<AutoOpen>]"
                  "module Automatic ="
                  "    type AutomaticType() = class end"
                  ""
                  "[<RequireQualifiedAccess>]"
                  "module Qualified ="
                  "    type QualifiedType() = class end" ]
        let automatic = source [ "module App.Automatic"; ""; "let value = AutomaticType()" ]
        let qualified = source [ "module App.Qualified"; ""; "let value = QualifiedType()" ]
        let! state, dir, _, paths =
            loadWorkspace [ "Declarations.fs", declarations; "Automatic.fs", automatic; "Qualified.fs", qualified ]
        try
            let automaticTitle =
                "Change 'AutomaticType' to 'Special.Automatic.AutomaticType' — qualifies this one use; no open added"
            let! automaticFixed, automaticEdit, automaticCheck =
                applySole state paths[1] automatic automaticTitle 2 13
            Assert.Equal("Special.Automatic.AutomaticType", automaticEdit.NewText)
            Assert.Equal(source [ "module App.Automatic"; ""; "let value = Special.Automatic.AutomaticType()" ], automaticFixed)
            assertNoErrors automaticCheck
            let qualifiedTitle =
                "Change 'QualifiedType' to 'Special.Qualified.QualifiedType' — qualifies this one use; no open added"
            let! qualifiedFixed, qualifiedEdit, qualifiedCheck =
                applySole state paths[2] qualified qualifiedTitle 2 13
            Assert.Equal("Special.Qualified.QualifiedType", qualifiedEdit.NewText)
            Assert.Equal(source [ "module App.Qualified"; ""; "let value = Special.Qualified.QualifiedType()" ], qualifiedFixed)
            assertNoErrors qualifiedCheck
        finally
            cleanup dir
    }

[<Fact>]
let ``open type imports a static member and a nested type with exact edits`` () =
    task {
        let sqrtSource = source [ "module StaticMembers"; ""; "let root = Sqrt 2.0" ]
        let nestedSource = source [ "module NestedTypes"; ""; "let desktop = SpecialFolder.Desktop" ]
        let! state, dir, _, paths = loadWorkspace [ "StaticMembers.fs", sqrtSource; "NestedTypes.fs", nestedSource ]
        try
            let sqrtTitle = "Add 'open type System.Math' — imports the static members and nested types of System.Math"
            let! sqrtFixed, sqrtEdit, sqrtCheck = applySole state paths[0] sqrtSource sqrtTitle 2 12
            Assert.Equal("open type System.Math\n", sqrtEdit.NewText)
            Assert.Equal(source [ "module StaticMembers"; ""; "open type System.Math"; "let root = Sqrt 2.0" ], sqrtFixed)
            assertNoErrors sqrtCheck
            let nestedTitle = "Add 'open type System.Environment' — imports the static members and nested types of System.Environment"
            let! nestedFixed, nestedEdit, nestedCheck = applySole state paths[1] nestedSource nestedTitle 2 15
            Assert.Equal("open type System.Environment\n", nestedEdit.NewText)
            Assert.Equal(source [ "module NestedTypes"; ""; "open type System.Environment"; "let desktop = SpecialFolder.Desktop" ], nestedFixed)
            assertNoErrors nestedCheck
        finally
            cleanup dir
    }

let internal projectXml name (references: string list) (packages: (string * string) list) =
    let projectReferences = references |> List.map (fun reference -> $"    <ProjectReference Include=\"{reference}\" />")
    let packageReferences = packages |> List.map (fun (id, version) -> $"    <PackageReference Include=\"{id}\" Version=\"{version}\" />")
    source
        [ "<Project Sdk=\"Microsoft.NET.Sdk\">"
          "  <PropertyGroup>"
          "    <TargetFramework>net10.0</TargetFramework>"
          "    <DisableImplicitFSharpCoreReference>true</DisableImplicitFSharpCoreReference>"
          "  </PropertyGroup>"
          "  <ItemGroup>"
          "    <Compile Include=\"Library.fs\" />"
          yield! projectReferences
          yield! packageReferences
          "  </ItemGroup>"
          "</Project>" ]
    |> fun xml -> name, xml

let internal writeSolution root (projects: (string * string * string) list) =
    projects
    |> List.iter (fun (name, xml, text) ->
        let directory = NativePaths.Resolve(root, name)
        Directory.CreateDirectory(directory) |> ignore
        File.WriteAllText(NativePaths.Resolve(directory, $"{name}.fsproj"), xml)
        File.WriteAllText(NativePaths.Resolve(directory, "Library.fs"), text))
    let entries = projects |> List.map (fun (name, _, _) -> $"  <Project Path=\"{name}/{name}.fsproj\" />")
    File.WriteAllText(NativePaths.Resolve(root, "Fixture.slnx"), source [ "<Solution>"; yield! entries; "</Solution>" ])

let internal loadSolution (projects: (string * string * string) list) =
    task {
        let root = NativePaths.Temp($"sharplsp-import-{Guid.NewGuid():N}")
        Directory.CreateDirectory(root) |> ignore
        writeSolution root projects
        let state = FSharpWorkspace.create ()
        let! loaded =
            FSharpWorkspaceLoading.loadWorkspaceWithCancellation
                state (NativePaths.Resolve(root, "Fixture.slnx")) true CancellationToken.None
        Assert.True(Result.isOk loaded, $"solution loads: {loaded}")
        return state, root
    }

let internal libraryPath (root: string) (name: string) =
    NativePaths.Resolve(root, name, "Library.fs")

[<Fact>]
let ``an unreferenced solution project is offered but a cycle is excluded`` () =
    task {
        let app = source [ "module App.Library"; ""; "let value = ExternalType()" ]
        let available = source [ "namespace External"; ""; "type ExternalType() = class end" ]
        let cycle = source [ "namespace Cyclic"; ""; "type ExternalType() = class end" ]
        let! state, root =
            loadSolution
                [ projectXml "App" [] [] |> fun (n, x) -> n, x, app
                  projectXml "Available" [] [] |> fun (n, x) -> n, x, available
                  projectXml "Cycle" [ "../App/App.fsproj" ] [] |> fun (n, x) -> n, x, cycle ]
        try
            let path = libraryPath root "App"
            let! _, actions = actionsAt state path 2 13
            let title = "Reference project Available from App.fsproj and add 'open External' — Available declares External.ExternalType"
            let action = actionNamed title actions
            let reference = referenceOf action
            Assert.Equal(ReferenceImport.ProjectKind, reference.Kind)
            Assert.Equal(NativePaths.Resolve(root, "App", "App.fsproj"), reference.ProjectPath)
            Assert.Equal(NativePaths.Resolve(root, "Available", "Available.fsproj"), reference.Reference)
            Assert.Equal("", reference.Version)
            Assert.DoesNotContain(actions, fun action -> action.Title.Contains("Reference project Cycle"))
            let! fixedSource, edit, checkedFile =
                applySole state path app title 2 13
            Assert.Equal("open External\n", edit.NewText)
            Assert.Equal(source [ "module App.Library"; ""; "open External"; "let value = ExternalType()" ], fixedSource)
            // The reference has not been added by resolve alone, so FS0039 remains until the host command runs.
            Assert.NotEmpty(linesWith 39 checkedFile)
        finally
            cleanup root
    }

[<Fact>]
let ``a solution package row and a project row coexist for one unresolved type`` () =
    task {
        let app = source [ "module App.Library"; ""; "let serializer = MessagePackSerializer.Serialize(1)" ]
        let declared = source [ "namespace MessagePack"; ""; "type MessagePackSerializer() = class end" ]
        let packages = source [ "module Packages.Library"; ""; "let value = 1" ]
        let! state, root =
            loadSolution
                [ projectXml "App" [] [] |> fun (n, x) -> n, x, app
                  projectXml "Declares" [] [] |> fun (n, x) -> n, x, declared
                  projectXml "Packages" [] [ ("MessagePack", "3.1.12") ] |> fun (n, x) -> n, x, packages ]
        try
            // The package project really carries the declaring assembly and a clean check.
            let packageTitle = "Add package MessagePack 3.1.12 to App.fsproj (as in Packages.fsproj) and add 'open MessagePack'"
            let projectTitle = "Reference project Declares from App.fsproj and add 'open MessagePack' — Declares declares MessagePack.MessagePackSerializer"
            let path = libraryPath root "App"
            let packageEntry = state.Projects.Values |> Seq.find (fun entry -> entry.Path.EndsWith("Packages.fsproj"))
            let! packageCheck = state.Checker.ParseAndCheckProject(FSharpWorkspace.wired state packageEntry.Options)
            Assert.True(
                packageEntry.Options.OtherOptions |> Array.exists (fun argument -> argument.Contains("MessagePack.dll")),
                $"package project options must carry MessagePack: {packageEntry.Options.OtherOptions}")
            Assert.Empty(packageCheck.Diagnostics |> Array.filter (fun diagnostic -> diagnostic.Severity = FSharpDiagnosticSeverity.Error))
            let declaring =
                packageCheck.ProjectContext.GetReferencedAssemblies()
                |> Seq.collect (fun assembly -> FSharpSemanticNavigation.allNested assembly.Contents.Entities)
                |> Seq.filter (fun entity -> entity.DisplayName = "MessagePackSerializer")
                |> List.ofSeq
            Assert.NotEmpty(declaring)
            // Both rows are offered for the same unresolved name, each with its exact reference.
            let! _, actions = actionsAt state path 2 18
            let packageAction = actionNamed packageTitle actions
            let packageReference = referenceOf packageAction
            Assert.Equal(ReferenceImport.PackageKind, packageReference.Kind)
            Assert.Equal(NativePaths.Resolve(root, "App", "App.fsproj"), packageReference.ProjectPath)
            Assert.Equal("MessagePack", packageReference.Reference)
            Assert.Equal("3.1.12", packageReference.Version)
            let projectAction = actionNamed projectTitle actions
            let projectReference = referenceOf projectAction
            Assert.Equal(ReferenceImport.ProjectKind, projectReference.Kind)
            Assert.Equal(NativePaths.Resolve(root, "App", "App.fsproj"), projectReference.ProjectPath)
            Assert.Equal(NativePaths.Resolve(root, "Declares", "Declares.fsproj"), projectReference.Reference)
            Assert.Equal("", projectReference.Version)
            // MessagePackSerializer is in the curated table, so a well-known row exists to
            // suppress: it is the fallback only while no solution row was found.
            Assert.DoesNotContain(actions, fun action -> action.Title.Contains("Install package"))
            let! byPackage, packageEdit, _ = applySole state path app packageTitle 2 18
            Assert.Equal("open MessagePack\n", packageEdit.NewText)
            Assert.Equal(source [ "module App.Library"; ""; "open MessagePack"; "let serializer = MessagePackSerializer.Serialize(1)" ], byPackage)
            let! byProject, projectEdit, projectCheck = applySole state path app projectTitle 2 18
            Assert.Equal("open MessagePack\n", projectEdit.NewText)
            Assert.Equal(byPackage, byProject)
            // Resolve alone never adds the reference, so FS0039 survives until the command runs.
            Assert.NotEmpty(linesWith 39 projectCheck)
            Assert.True(File.Exists(NativePaths.Resolve(root, "Packages", "obj", "project.assets.json")))
        finally
            cleanup root
    }

/// The one action with `title`, with its offered titles when there is not exactly one.
let private soleOffered (title: string) (actions: FSharpCodeActions.GeneratedAction list) =
    match actions |> List.filter (fun action -> action.Title = title) with
    | [ action ] -> action
    | offered ->
        let names = actions |> List.map (fun action -> action.Title) |> String.concat "; "
        failwith $"expected exactly one '{title}', {offered.Length} offered; all: {names}"

/// `action`'s sole edit as (startLine, startChar, endLine, endChar, newText).
let private editOf (action: FSharpCodeActions.GeneratedAction) =
    let edit = Assert.Single(action.Edits)
    (edit.StartLine, edit.StartCharacter, edit.EndLine, edit.EndCharacter, edit.NewText)

/// [REFACTOR-IMPORT-FSHARP] SDK 10.0.404+ reports `Task.Delay(1)`'s FS0039 on the member
/// `Delay` of the unopened type, where 10.0.403 reported it on `Task` itself. Both
/// diagnostic shapes must offer the same `open` insertion position (GitHub #583).
[<Fact>]
let ``both FS0039 shapes of an unopened type offer its namespace open`` () =
    task {
        let original = source [ "module Tasks.Library"; ""; "let value = Task.Delay(1)" ]
        let! state, dir, _, paths = loadWorkspace [ ("Tasks.fs", original) ]
        try
            let! parse, before, src = checkedFixture state paths[0]
            let openTitle = "Add 'open System.Threading.Tasks' — imports every type and module in namespace System.Threading.Tasks"
            let shape (start, finish) qualifyTitle span =
                let range = Range.mkRange paths[0] (Position.mkPos 3 start) (Position.mkPos 3 finish)
                let actions = FSharpNameFixes.imports state parse before src paths[0] range
                Assert.Equal((2, 0, 2, 0, "open System.Threading.Tasks\n"), soleOffered openTitle actions |> editOf)
                Assert.Equal(span, soleOffered qualifyTitle actions |> editOf)
            // 10.0.403: the range covers `Task`; qualify replaces that ident alone.
            shape
                (12, 16)
                "Change 'Task' to 'System.Threading.Tasks.Task' — qualifies this one use; no open added"
                (2, 12, 2, 16, "System.Threading.Tasks.Task")
            // 10.0.404+: the range covers `Delay`; qualify replaces the whole `Task.Delay`.
            shape
                (17, 22)
                "Change 'Task.Delay' to 'System.Threading.Tasks.Task.Delay' — qualifies this one use; no open added"
                (2, 12, 2, 22, "System.Threading.Tasks.Task.Delay")
            // Whichever shape this SDK reports, applying the open clears FS0039 for real.
            let! fixedSource, _openEdit, checkedFile = applySole state paths[0] original openTitle 2 13
            Assert.Equal(
                source [ "module Tasks.Library"; ""; "open System.Threading.Tasks"; "let value = Task.Delay(1)" ],
                fixedSource
            )
            assertNoErrors checkedFile
        finally
            cleanup dir
    }

/// [REFACTOR-IMPORT-FSHARP] The member re-target must stay gated on the qualifier
/// being unresolved: a misspelled member of a type already in scope (`Console` via
/// `open System`) is a typo, not a missing namespace.
[<Fact>]
let ``a member misspelling of a type in scope gains no namespace open`` () =
    task {
        let original = source [ "module Console.Library"; ""; "open System"; "let value = Console.ReadLnie()" ]
        let! state, dir, _, paths = loadWorkspace [ ("Console.fs", original) ]
        try
            let! parse, before, src = checkedFixture state paths[0]
            let range = Range.mkRange paths[0] (Position.mkPos 4 20) (Position.mkPos 4 28)
            let actions = FSharpNameFixes.imports state parse before src paths[0] range
            // The compiler reports the member miss on `ReadLnie` itself.
            let diagnostic = Assert.Single(before.Diagnostics |> Array.filter (fun d -> d.ErrorNumber = 39))
            Assert.Equal((4, 20, 4, 28), (diagnostic.StartLine, diagnostic.StartColumn, diagnostic.EndLine, diagnostic.EndColumn))
            Assert.Empty(actions |> List.filter (fun action -> action.Title.StartsWith("Add 'open")))
            Assert.Empty(actions |> List.filter (fun action -> action.Title.StartsWith("Change 'Console")))
        finally
            cleanup dir
    }

[<Fact>]
let ``a well known package is offered only with an explicit latest stable install title`` () =
    task {
        let original = source [ "module App.Library"; ""; "let provider = typeof<JsonProvider>" ]
        let! state, root = loadSolution [ projectXml "App" [] [] |> fun (n, x) -> n, x, original ]
        try
            let title = "Install package FSharp.Data (latest stable from nuget.org) in App.fsproj and add 'open FSharp.Data'"
            let path = libraryPath root "App"
            let! _, actions = actionsAt state path 2 16
            let action = actionNamed title actions
            let reference = referenceOf action
            Assert.Equal(ReferenceImport.PackageKind, reference.Kind)
            Assert.Equal(NativePaths.Resolve(root, "App", "App.fsproj"), reference.ProjectPath)
            Assert.Equal("FSharp.Data", reference.Reference)
            Assert.Equal("", reference.Version)
            let! fixedSource, edit, _ = applySole state path original title 2 16
            Assert.Equal("open FSharp.Data\n", edit.NewText)
            Assert.Equal(source [ "module App.Library"; ""; "open FSharp.Data"; "let provider = typeof<JsonProvider>" ], fixedSource)
        finally
            cleanup root
    }

/// [REFACTOR-IMPORT-FSHARP] FSharp.Core 10.1.404 (SDK 10.0.404+) auto-opens a `Task`
/// module, so an unopened `Task.Delay(1)` binds `Task` to that module and FCS reports
/// FS0039 on `Delay`. The open-namespace fix must still be offered there, and applying
/// it must clear the error for real (GitHub #583).
[<Fact>]
let ``Task Delay against FSharp Core with a Task module offers the tasks namespace open`` () =
    task {
        let app = source [ "module App.Library"; ""; "let value = Task.Delay(1)" ]
        let! state, root = loadSolution [ projectXml "App" [] [ ("FSharp.Core", "10.1.404") ] |> fun (n, x) -> n, x, app ]
        try
            let path = libraryPath root "App"
            let! _, before, _ = checkedFixture state path
            let delay = Assert.Single(before.Diagnostics |> Array.filter (fun d -> d.ErrorNumber = 39))
            Assert.Equal((3, 17, 3, 22), (delay.StartLine, delay.StartColumn, delay.EndLine, delay.EndColumn))
            Assert.Contains("'Delay'", delay.Message)
            let openTitle = "Add 'open System.Threading.Tasks' — imports every type and module in namespace System.Threading.Tasks"
            let! _, actions = actionsAt state path 2 18
            Assert.Contains(actions, fun action -> action.Title.StartsWith("Change 'Task.Delay' to 'System.Threading.Tasks.Task.Delay'"))
            let! fixedSource, edit, checkedFile = applySole state path app openTitle 2 18
            Assert.Equal("open System.Threading.Tasks\n", edit.NewText)
            Assert.Equal(source [ "module App.Library"; ""; "open System.Threading.Tasks"; "let value = Task.Delay(1)" ], fixedSource)
            assertNoErrors checkedFile
        finally
            cleanup root
    }

let private orderProject (dir: string) (order: string list) =
    let items = order |> List.map (fun file -> $"<Compile Include=\"{file}\" />") |> String.concat ""
    File.WriteAllText(
        NativePaths.Resolve(dir, "Order.fsproj"),
        "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework>"
        + "<DisableImplicitFSharpCoreReference>true</DisableImplicitFSharpCoreReference></PropertyGroup>"
        + $"<ItemGroup>{items}</ItemGroup></Project>")

let private loadOrdered (dir: string) =
    task {
        let state = FSharpWorkspace.create ()
        let! _ = FSharpWorkspaceLoading.loadProject state dir
        return state
    }

/// [REFACTOR-FSHARP-FILE-ORDER] A name a LATER file of the project declares is a
/// compile-order problem: the fix is one command action per declaring file, with
/// no edit and nothing searched outside the project; once the file is above, FCS
/// has no FS0039 left and no move is offered.
[<Fact>]
let ``a name declared by a later file offers moving that file above, and nothing outside the project`` () =
    task {
        let dir = NativePaths.Temp($"sharplsp-order-{Guid.NewGuid():N}")
        Directory.CreateDirectory(dir) |> ignore
        try
            let aPath, bPath = NativePaths.Resolve(dir, "A.fs"), NativePaths.Resolve(dir, "B.fs")
            File.WriteAllText(aPath, source [ "module P.A"; ""; "let useB = B.value"; "let typo = Missing.value" ])
            File.WriteAllText(NativePaths.Resolve(dir, "Mid.fs"), source [ "module P.Mid"; ""; "let unrelated = 1" ])
            File.WriteAllText(bPath, source [ "module P.B"; ""; "let value = 42" ])
            orderProject dir [ "A.fs"; "Mid.fs"; "B.fs" ]
            let! state = loadOrdered dir
            let! _, before, _ = checkedFixture state aPath
            Assert.Equal<int array>([| 2; 3 |], linesWith 39 before)
            // Interaction 1: the forward dependency offers exactly the move.
            let title = "Move B.fs above A.fs in Order.fsproj — B.fs declares 'B' but compiles after A.fs"
            let! fixes, actions = actionsAt state aPath 2 11
            let move = actionNamed title actions
            Assert.Equal("quickfix", move.Kind)
            Assert.False(move.IsPreferred)
            let reference = referenceOf move
            Assert.Equal(ReferenceImport.CompileOrderKind, reference.Kind)
            Assert.Equal(NativePaths.Resolve(dir, "Order.fsproj"), reference.ProjectPath)
            Assert.Equal("B.fs", reference.Reference)
            Assert.Equal("A.fs", reference.Version)
            Assert.DoesNotContain(actions, fun action -> action.Title.Contains("Mid.fs"))
            Assert.DoesNotContain(actions, fun action -> action.Title.Contains("Install package"))
            Assert.DoesNotContain(actions, fun action -> action.Title.Contains("Reference project"))
            // The move is the command alone: its action carries no text edit.
            let edit = FSharpCodeFixes.resolveCodeAction fixes move.Id |> Option.defaultWith (fun () -> failwith "move did not resolve")
            Assert.Empty(edit.DocumentChanges)
            // Interaction 2: a name no later file declares offers no move.
            let! _, typoActions = actionsAt state aPath 3 11
            Assert.DoesNotContain(typoActions, fun action -> action.Title.StartsWith("Move ", StringComparison.Ordinal))
            // Interaction 3: nothing compiles after B.fs, so B.fs never offers one.
            let! _, lastActions = actionsAt state bPath 2 4
            Assert.DoesNotContain(lastActions, fun action -> action.Title.StartsWith("Move ", StringComparison.Ordinal))
            // Interaction 4: with B.fs above A.fs (what the host's move writes) the name resolves.
            orderProject dir [ "B.fs"; "A.fs"; "Mid.fs" ]
            let! moved = loadOrdered dir
            let! _, after, _ = checkedFixture moved aPath
            Assert.Equal<int array>([| 3 |], linesWith 39 after)
            let! _, afterActions = actionsAt moved aPath 2 11
            Assert.DoesNotContain(afterActions, fun action -> action.Title.StartsWith("Move ", StringComparison.Ordinal))
        finally
            cleanup dir
    }
