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

/// Long past the grace a fresh sidecar gets to load its workspace.
let private settled = TimeSpan.FromHours 1.0

/// One check of a settled sidecar: the budget it keeps next, and the exit codes it asked for.
let private checkOnce state values =
    let stops = Collections.Generic.List<int>()
    let next = watch state budget settled (readings values) stops.Add
    next, List.ofSeq stops

[<Fact>]
let ``within the budget the checker keeps its caches`` () =
    withProject (fun state _ file ->
        task {
            let! options = checkedOptions state file
            Assert.Equal((budget, []), checkOnce state [ 1000L ])
            Assert.True(cached state file options, "nothing was trimmed at the soft limit")
            Assert.Equal((budget, []), checkOnce state [ 10L ])
            Assert.True(cached state file options, "a low reading trims nothing either")
        })

[<Fact>]
let ``over the soft limit the checker trims its caches and still answers`` () =
    withProject (fun state _ file ->
        task {
            let! options = checkedOptions state file
            Assert.Equal(({ budget with SoftBytes = 1251L }, []), checkOnce state [ 1001L; 1500L ])
            Assert.False(cached state file options, "the trim dropped the check results")
            let! again = checkedOptions state file
            Assert.Equal<string array>(options.SourceFiles, again.SourceFiles)
            Assert.Equal(({ budget with SoftBytes = 5250L }, []), checkOnce state [ 5000L; 2000L ])
            Assert.False(cached state file again, "a second trim drops the rebuilt results")
        })

[<Fact>]
let ``still over the hard limit after trimming asks for a restart`` () =
    withProject (fun state _ file ->
        task {
            let! options = checkedOptions state file
            Assert.Equal<int list>([ OverLimitExitCode ], snd (checkOnce state [ 3000L; 2001L ]))
            Assert.False(cached state file options, "the sidecar trimmed before giving up")
            Assert.Equal(3, OverLimitExitCode)
            Assert.True(residentBytes () > 0L, "the live measurement reads this process's resident set")
        })

[<Fact>]
let ``a budget check stops the process only when trimming cannot get under the hard limit`` () =
    withProject (fun state _ file ->
        task {
            let stops = Collections.Generic.List<int>()
            let! options = checkedOptions state file
            watch state budget settled (readings [ 500L ]) stops.Add |> ignore
            Assert.Empty(stops)
            Assert.True(cached state file options, "a check within the budget trims nothing")
            watch state budget settled (readings [ 1500L; 1200L ]) stops.Add |> ignore
            Assert.Empty(stops)
            Assert.False(cached state file options, "a check over the soft limit trims")
            watch state budget settled (readings [ 4000L; 2500L ]) stops.Add |> ignore
            Assert.Equal<int list>([ OverLimitExitCode ], List.ofSeq stops)
        })

/// A workspace whose live set sits between the limits is not a leak: one trim proves the
/// caches are needed, so the next checks at that level keep them. Trimming every 30 s
/// made every request rebuild everything, forever. [SIDECAR-PROCESS-MEMORY]
[<Fact>]
let ``a workspace settled between the limits is trimmed once, not every check`` () =
    withProject (fun state _ file ->
        task {
            let stops = Collections.Generic.List<int>()
            let! first = checkedOptions state file

            // Interaction 1 — the first check over the soft limit trims and raises the bar.
            let raised = watch state budget settled (readings [ 1500L; 1400L ]) stops.Add
            Assert.False(cached state file first, "the first check over the soft limit trims")
            Assert.Equal(1750L, raised.SoftBytes)
            Assert.Equal(budget.HardBytes, raised.HardBytes)
            Assert.Empty(stops)

            // Interaction 2 — rebuilt to the same level, the caches now survive every check.
            let! rebuilt = checkedOptions state file
            let mutable kept = raised

            for _ in 1..5 do
                kept <- watch state kept settled (readings [ 1500L ]) stops.Add
                Assert.True(cached state file rebuilt, "the same level is not trimmed again")

            Assert.Equal(raised, kept)
            Assert.Empty(stops)

            // Interaction 3 — real growth past the raised bar trims again, and raises it again.
            let grown = watch state kept settled (readings [ 1751L; 1700L ]) stops.Add
            Assert.False(cached state file rebuilt, "growth past the raised bar trims")
            Assert.Equal(2001L, grown.SoftBytes)
            Assert.Empty(stops)
        })

/// A workspace that is over the hard limit minutes after the sidecar started would be
/// over it again minutes after a restart: exiting only loops. It keeps serving and says
/// which setting to raise; a sidecar that grew over the limit over a long session still
/// exits for a fresh start. [SIDECAR-PROCESS-MEMORY]
[<Fact>]
let ``a workspace over the hard limit while loading is served, not restarted in a loop`` () =
    withProject (fun state _ file ->
        task {
            let stops = Collections.Generic.List<int>()
            let! options = checkedOptions state file

            // Interaction 1 — over the hard limit one minute in: trimmed, never stopped.
            let loading = TimeSpan.FromMinutes 1.0
            let raised = watch state budget loading (readings [ 3000L; 2900L ]) stops.Add
            Assert.Empty(stops)
            Assert.False(cached state file options, "it still trimmed once")
            Assert.Equal(3250L, raised.SoftBytes)

            // Interaction 2 — settled at that size, later checks neither trim nor stop.
            let! rebuilt = checkedOptions state file
            let kept = watch state raised settled (readings [ 3000L ]) stops.Add
            Assert.Empty(stops)
            Assert.True(cached state file rebuilt, "the oversized workspace keeps its caches")
            Assert.Equal(raised, kept)

            // Interaction 3 — a long session that grows past the bar and cannot trim back exits.
            watch state kept settled (readings [ 3300L; 3200L ]) stops.Add |> ignore
            Assert.Equal<int list>([ OverLimitExitCode ], List.ofSeq stops)
            Assert.True(GraceForLoading > loading && GraceForLoading < settled, "the grace is minutes")
        })

/// A workspace that trimmed down to 2900 while loading NEEDS 2900: that is its floor, not
/// a leak. A later trim that gets it back to that floor must not exit — the restarted
/// sidecar reloads straight back to it, so exiting restarted it every few minutes for
/// the rest of the session. Only a trim that cannot get back near the proven floor is
/// growth worth a fresh start. [SIDECAR-PROCESS-MEMORY]
[<Fact>]
let ``a workspace trimmed back to its proven loading size is served, not restarted every session`` () =
    withProject (fun state _ file ->
        task {
            let stops = Collections.Generic.List<int>()
            let! options = checkedOptions state file

            // Interaction 1 — over the hard limit while loading: the floor it trims to is proven.
            let loading = TimeSpan.FromMinutes 1.0
            let proven = watch state budget loading (readings [ 3000L; 2900L ]) stops.Add
            Assert.Empty(stops)
            Assert.Equal(3250L, proven.SoftBytes)
            Assert.Equal(3150L, proven.HardBytes)

            // Interaction 2 — long after loading, caches regrow and a trim returns to the floor.
            let! rebuilt = checkedOptions state file
            let regrown = watch state proven settled (readings [ 3300L; 2950L ]) stops.Add
            Assert.False(cached state file rebuilt, "the regrown caches were trimmed")
            Assert.Empty(stops)
            Assert.Equal(proven.HardBytes, regrown.HardBytes)

            // Interaction 3 — a trim that cannot get back near the floor is growth: it exits.
            let! _ = checkedOptions state file
            watch state regrown settled (readings [ 3800L; 3600L ]) stops.Add |> ignore
            Assert.Equal<int list>([ OverLimitExitCode ], List.ofSeq stops)
            Assert.True(options.SourceFiles.Length > 0, "the workspace kept answering throughout")
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
