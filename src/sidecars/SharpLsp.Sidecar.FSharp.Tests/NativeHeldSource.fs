/// Actual source I/O, never a compiler hook. [DIAG-ANALYSIS-CANCELLATION]
module SharpLsp.Sidecar.FSharp.Tests.NativeHeldSource

open System
open System.Diagnostics
open System.IO
open System.Runtime.InteropServices
open System.Text
open System.Text.Json
open System.Threading.Tasks
open SharpLsp.Sidecar.Common
open Xunit

type HeldSource(opened: Task, completion: Task, release: unit -> Task) =
    member _.Opened = opened
    member _.IsHeld = not completion.IsCompleted
    member _.Release() = release()
    interface IAsyncDisposable with
        member _.DisposeAsync() = ValueTask(release())

let private signal () = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)

/// Native helpers run hidden and receive each argument without shell interpolation.
let internal start command arguments =
    let info = ProcessStartInfo(command, UseShellExecute = false, CreateNoWindow = true,
                                RedirectStandardInput = true, RedirectStandardOutput = true,
                                RedirectStandardError = true)
    arguments |> List.iter info.ArgumentList.Add
    Process.Start(info) |> Assert.IsType<Process>

let private release (requested: TaskCompletionSource<unit>) (completion: Task) : Task = task {
    requested.TrySetResult(()) |> ignore
    do! completion.WaitAsync(TimeSpan.FromSeconds(30.0))
}

/// Opening the FIFO succeeds only after the real sidecar has opened its read end.
let private unixOwner (path: string) (saved: string) (opened: TaskCompletionSource<unit>) (requested: TaskCompletionSource<unit>) =
    use writer = File.Open(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)
    opened.SetResult(())
    requested.Task.Wait(TimeSpan.FromSeconds(20.0)) |> ignore
    File.Delete(path)
    File.WriteAllText(path, saved)
    let bytes = Encoding.UTF8.GetBytes(saved)
    writer.Write(bytes, 0, bytes.Length)

let private unix path saved = task {
    File.Delete(path)
    use command = start "mkfifo" [path]
    do! command.WaitForExitAsync()
    Assert.Equal(0, command.ExitCode)
    let opened, requested = signal(), signal()
    let owner = Task.Run(Action(fun () -> unixOwner path saved opened requested))
    return new HeldSource(opened.Task, owner, fun () -> release requested owner)
}

/// The shared NTFS owner signals kernel oplock progress as structured data.
let private state (child: Process) (expected: string) = task {
    let! line = child.StandardOutput.ReadLineAsync()
    let text = Assert.IsType<string>(line)
    use document = JsonDocument.Parse(text)
    Assert.Equal<string option>(Some expected, document.RootElement.GetProperty("state").GetString() |> Option.ofObj)
}

let private windowsOwner (child: Process) (opened: TaskCompletionSource<unit>) (requested: TaskCompletionSource<unit>) : Task = task {
    do! state child "blocked"
    opened.SetResult(())
    let! _ = Task.WhenAny(requested.Task :> Task, Task.Delay(TimeSpan.FromSeconds(20.0)))
    child.StandardInput.Close()
    do! state child "released"
    do! child.WaitForExitAsync()
    Assert.Equal(0, child.ExitCode)
    child.Dispose()
}

let private windows path = task {
    let script = NativePaths.Resolve(__SOURCE_DIRECTORY__, "../../../lspkit/test-support/windows-oplock/hold.ps1")
    let child = start "powershell.exe" ["-NoProfile"; "-NonInteractive"; "-ExecutionPolicy"; "Bypass"; "-File"; script; "-Source"; path]
    try
        do! state child "ready"
        let opened, requested = signal(), signal()
        let owner = windowsOwner child opened requested
        return new HeldSource(opened.Task, owner, fun () -> release requested owner)
    with error ->
        child.StandardInput.Close()
        return raise error
}

/// Select a native I/O primitive; path spelling and identity remain in NativePaths.
let create path saved =
    if RuntimeInformation.IsOSPlatform(OSPlatform.Windows) then windows path else unix path saved
