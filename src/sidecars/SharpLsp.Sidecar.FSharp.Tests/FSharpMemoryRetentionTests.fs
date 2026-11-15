/// The F# sidecar holds a bounded working set: a reload releases the builds of the graph
/// it replaces, and over its memory budget the checker drops its caches and still answers
/// afterwards (GitHub #566). Implements [SIDECAR-PROCESS-MEMORY].
module SharpLsp.Sidecar.FSharp.Tests.FSharpMemoryRetentionTests

open System
open System.IO
open System.Xml.Linq
open FSharp.Compiler.Text
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.FSharpMemoryBudget
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpMultiProjectTests

let private source = "module Leak.Program\n\nlet answer = 42\n"

/// Compile `Extra{round}.fs` ahead of the project's files, so each reload yields
/// options of their own, as a restore or project edit does.
let private addFile (project: string) (round: int) =
    let name = $"Extra{round}.fs"
    File.WriteAllText(NativePaths.Resolve(NativePaths.DirectoryOf project, name), $"module Leak.Extra{round}\n")
    let document = XDocument.Load project
    let items = document.Descendants(XName.Get "ItemGroup") |> Seq.head
    items.AddFirst(XElement(XName.Get "Compile", XAttribute(XName.Get "Include", name)))
    document.Save project

/// Whether the checker still holds results for `file` under `options`.
let private cached (state: FSharpWorkspace.FSharpWorkspaceState) file options =
    let projectPath = FSharpWorkspace.projectFilePath state file
    state.Checker.TryGetRecentCheckResultsForFile(projectPath, options, SourceText.ofString source).IsSome

/// Check `file` and return the options it was checked under, asserting the checker
/// now caches results for exactly those options.
let private checkedOptions (state: FSharpWorkspace.FSharpWorkspaceState) file =
    task {
        let! checkedFile = FSharpWorkspace.checkFile state file
        Assert.True(checkedFile.IsSome, "the file checks in its project")
        let options = (FSharpWorkspace.optionsFor state file).Value
        Assert.True(cached state file options, "current build is cached")
        return options
    }

/// A real one-project workspace, loaded; disposed with its folder.
let private withProject (body: FSharpWorkspace.FSharpWorkspaceState -> string -> string -> Threading.Tasks.Task<unit>) =
    task {
        let root = NativePaths.Temp($"sharplsp-memory-{Guid.NewGuid():N}")
        let file = writeProject root "Leak" "Program.fs" source []
        let state = FSharpWorkspace.create ()

        try
            let! loaded = FSharpWorkspaceLoading.loadProject state root
            Assert.True(Result.isOk loaded, $"project loads: {loaded}")
            do! body state root file
        finally
            cleanup root
    }

/// A measurement that reads `values` in turn.
let private readings (values: int64 list) =
    let remaining = Collections.Generic.Queue<int64>(values)
    fun () -> remaining.Dequeue()

let private budget = { SoftBytes = 1000L; HardBytes = 2000L }

[<Fact>]
let ``reloading a project releases the builds of the options it replaced`` () =
    withProject (fun state root file ->
        task {
            let project = NativePaths.Resolve(root, "Leak", "Leak.fsproj")
            let! first = checkedOptions state file
            let mutable stale = first

            for round in 1..3 do
                addFile project round
                let! reloaded = FSharpWorkspaceLoading.loadProject state root
                Assert.True(Result.isOk reloaded, $"reload {round} succeeds: {reloaded}")
                let! current = checkedOptions state file
                Assert.Equal(round + 1, current.SourceFiles.Length)
                Assert.False(cached state file stale, $"reload {round} released the stale build")
                Assert.False(cached state file first, $"reload {round} keeps the first build released")
                stale <- current
        })

[<Fact>]
let ``within the budget the checker keeps its caches`` () =
    withProject (fun state _ file ->
        task {
            let! options = checkedOptions state file
            Assert.Equal(Within, enforce state budget (readings [ 1000L ]))
            Assert.True(cached state file options, "nothing was trimmed at the soft limit")
            Assert.Equal(Within, enforce state budget (readings [ 10L ]))
            Assert.True(cached state file options, "a low reading trims nothing either")
        })

[<Fact>]
let ``over the soft limit the checker trims its caches and still answers`` () =
    withProject (fun state _ file ->
        task {
            let! options = checkedOptions state file
            Assert.Equal(Trimmed, enforce state budget (readings [ 1001L; 1500L ]))
            Assert.False(cached state file options, "the trim dropped the check results")
            let! again = checkedOptions state file
            Assert.Equal<string array>(options.SourceFiles, again.SourceFiles)
            Assert.Equal(Trimmed, enforce state budget (readings [ 5000L; 2000L ]))
            Assert.False(cached state file again, "a second trim drops the rebuilt results")
        })

[<Fact>]
let ``still over the hard limit after trimming asks for a restart`` () =
    withProject (fun state _ file ->
        task {
            let! options = checkedOptions state file
            Assert.Equal(OverHardLimit, enforce state budget (readings [ 3000L; 2001L ]))
            Assert.False(cached state file options, "the sidecar trimmed before giving up")
            Assert.Equal(3, OverLimitExitCode)
        })

[<Fact>]
let ``the memory limit setting sets the soft limit and twice it as the hard limit`` () =
    let mb = 1024L * 1024L
    Assert.Equal({ SoftBytes = 800L * mb; HardBytes = 1600L * mb }, budgetFrom (Some "800"))
    Assert.Equal({ SoftBytes = 2048L * mb; HardBytes = 4096L * mb }, defaultBudget)
    Assert.Equal(defaultBudget, budgetFrom None)
    Assert.Equal(defaultBudget, budgetFrom (Some "0"))
    Assert.Equal(defaultBudget, budgetFrom (Some "-5"))
    Assert.Equal(defaultBudget, budgetFrom (Some "lots"))
    Assert.Equal("SHARPLSP_FSHARP_MEMORY_LIMIT_MB", LimitVariable)
