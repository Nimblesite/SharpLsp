// Profiler target: realistic hotspots so dotnet-trace captures named, comparable call stacks.
// Runs until killed (SIGINT/SIGTERM).

using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

// Self-terminate when orphaned: if the parent (the test host) dies abnormally —
// e.g. nextest SIGKILLs a timed-out test — Rust-side `Drop` cleanup never runs
// and this CPU-bound process would leak as a runaway (issue #3). POSIX: watch
// the parent PID and cancel once we are reparented. Windows: wait on a handle
// to the original parent process (no reparenting exists there).
StartParentDeathWatchdog(cts);

Console.WriteLine("READY");
await Console.Out.FlushAsync().ConfigureAwait(false);

var tasks = new[]
{
    Task.Run(() => SlowJsonParsing(cts.Token), cts.Token),
    Task.Run(() => FastJsonParsing(cts.Token), cts.Token),
    Task.Run(() => LockContention(cts.Token), cts.Token),
    Task.Run(() => DeepCallStack(cts.Token), cts.Token),
    Task.Run(() => StringBuilderAllocation(cts.Token), cts.Token),
};

try { await Task.WhenAll(tasks).ConfigureAwait(false); }
catch (OperationCanceledException) { }

// Cancel `cts` as soon as this process is reparented away from its original
// parent (getppid changes), which happens the instant the parent dies — so an
// orphaned target shuts down its workers and exits instead of running forever.
//
// Runs on a dedicated background thread, NOT the thread pool: the worker loops
// below are tight CPU-bound spins that saturate the pool, which would starve an
// async `Task.Delay` watchdog and stop it ever re-checking. A real thread is
// time-sliced in by the OS regardless.
static void StartParentDeathWatchdog(CancellationTokenSource cts)
{
    if (OperatingSystem.IsWindows())
    {
        StartWindowsParentDeathWatchdog(cts);
        return;
    }

    var initialParentPid = NativeMethods.getppid();
    var watchdog = new Thread(() =>
    {
        while (!cts.IsCancellationRequested)
        {
            var currentParentPid = NativeMethods.getppid();
            // ppid == 1 means we were reparented to init/launchd, i.e. orphaned;
            // a *changed* ppid additionally covers a Linux child-subreaper. The
            // `== 1` check also wins the race where the parent dies during our own
            // startup, before `initialParentPid` could be captured.
            if (currentParentPid == 1 || currentParentPid != initialParentPid)
            {
                cts.Cancel();
                return;
            }
            Thread.Sleep(250);
        }
    })
    {
        IsBackground = true,
        Name = "parent-death-watchdog",
    };
    watchdog.Start();
}

// Windows counterpart of the watchdog: there is no reparenting on Windows —
// the recorded parent PID just goes stale when the parent dies — so instead we
// open a handle to the original parent at startup (a live handle is immune to
// PID reuse) and block a dedicated thread on its exit. Same real-thread
// rationale as the POSIX path: the CPU-bound workers saturate the thread pool.
static void StartWindowsParentDeathWatchdog(CancellationTokenSource cts)
{
    // The direct parent may be an MSYS exec-stub (`sh` spawning a native
    // binary keeps a wrapper alive exactly as long as we live — it waits on
    // us), so watching it alone can never fire. Watch a few LIVE ancestors
    // (parent, grandparent, ...) instead and self-terminate when ANY of them
    // exits: whichever layer the harness kills, we notice. Handles are opened
    // immediately at startup, so the waits are immune to PID reuse.
    var ancestors = LiveAncestors(maxDepth: 3);
    WatchdogLog(
        $"watching ancestors: {string.Join(", ", ancestors.Select(a => $"{a.Id} ({SafeName(a)})"))}"
    );
    foreach (var ancestor in ancestors)
    {
        var watched = ancestor;
        var watchdog = new Thread(() =>
        {
            try
            {
                watched.WaitForExit();
                WatchdogLog($"ancestor {watched.Id} exited -> cancel");
            }
            catch (SystemException ex)
            {
                // Wait failure means we can no longer observe the ancestor;
                // treat it as death so we never linger as an unwatched orphan.
                WatchdogLog($"wait on ancestor {watched.Id} failed ({ex.GetType().Name}) -> cancel");
            }

            cts.Cancel();
        })
        {
            IsBackground = true,
            Name = $"parent-death-watchdog-{watched.Id}",
        };
        watchdog.Start();
    }
}

// Walk the creator chain upward, collecting ancestors that are still alive.
// Stops at the first dead/unqueryable link (the chain is unknowable past it)
// or at a system PID. An empty result means "run unguarded" — dying
// spuriously would be worse than the (test-only) risk of leaking.
static List<System.Diagnostics.Process> LiveAncestors(int maxDepth)
{
    var result = new List<System.Diagnostics.Process>();
    var pid = NativeMethods.GetParentPid(System.Diagnostics.Process.GetCurrentProcess().Handle);
    for (var depth = 0; depth < maxDepth && pid > 4; depth++)
    {
        System.Diagnostics.Process ancestor;
        try
        {
            ancestor = System.Diagnostics.Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            break; // Dead: cannot query its creator, chain ends here.
        }

        result.Add(ancestor);
        try
        {
            pid = NativeMethods.GetParentPid(ancestor.Handle);
            WatchdogLog($"ancestor {ancestor.Id} -> creator {pid}");
        }
        catch (SystemException ex)
        {
            // Covers InvalidOperationException too: the ancestor exited
            // between GetProcessById and Handle — the chain ends here.
            WatchdogLog($"creator query on {ancestor.Id} failed ({ex.GetType().Name})");
            break;
        }
    }

    return result;
}

// Opt-in watchdog diagnostics: set PROFILE_TARGET_WATCHDOG_LOG to a file path
// to record the watchdog's decisions. Off by default; the fixture's stdio is
// redirected to /dev/null by several harnesses, so a file is the only channel
// that can explain an unexpected early exit.
static void WatchdogLog(string message)
{
    var path = Environment.GetEnvironmentVariable("PROFILE_TARGET_WATCHDOG_LOG");
    if (string.IsNullOrEmpty(path))
        return;
    try
    {
        File.AppendAllText(
            path,
            System.FormattableString.Invariant(
                $"{DateTime.UtcNow:O} [pid {Environment.ProcessId}] {message}{Environment.NewLine}"
            )
        );
    }
    catch (IOException)
    {
        // Diagnostics must never take the fixture down.
    }
}

static string SafeName(System.Diagnostics.Process process)
{
    try
    {
        return process.ProcessName;
    }
    catch (InvalidOperationException)
    {
        return "<exited>";
    }
}

// Slow path: allocates a new string payload and deserializes to a Dictionary every iteration.
static void SlowJsonParsing(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        var json = BuildLargeJsonPayload(256);
        _ = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json);
    }
}

// Fast path: reuses a single pre-built JsonDocument with a reader over a fixed buffer.
static void FastJsonParsing(CancellationToken ct)
{
    var payload = BuildLargeJsonPayload(256);
    var bytes = Encoding.UTF8.GetBytes(payload);
    while (!ct.IsCancellationRequested)
    {
        var buf = new byte[1024 * 4];
        buf[0] = 1;
        _ = string.Join(",", Enumerable.Range(0, 128).Select(i => $"item-{i}"));
        Thread.Sleep(1);
    }
}

// Lock contention: multiple logical "workers" compete on a shared queue.
// Shows up as Monitor.Enter wait time vs actual work time in the flame graph.
static void LockContention(CancellationToken ct)
{
    var queue = new Queue<int>();
    var locker = new object();
    const int maxQueueDepth = 256;
    var producer = Task.Run(() =>
    {
        var i = 0;
        while (!ct.IsCancellationRequested)
        {
            lock (locker)
            {
                if (queue.Count < maxQueueDepth)
                    queue.Enqueue(i++);
            }
            Thread.SpinWait(128);
        }
    }, ct);

    while (!ct.IsCancellationRequested)
    {
        lock (locker)
        {
            if (queue.Count > 0)
                _ = queue.Dequeue();
        }
        Fibonacci(28);
        Thread.Sleep(5);
    }
}

// Deep named call stack so the sampler captures distinct frame names at each depth.
static void DeepCallStack(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
        ParseDocument(BuildLargeJsonPayload(64));
}

static long Fibonacci(int n) => n <= 1 ? n : Fibonacci(n - 1) + Fibonacci(n - 2);

static void ParseDocument(string text) => TokenizeText(text);
static void TokenizeText(string text) => CountTokens(text);
static void CountTokens(string text) => SumCharValues(text);
static int SumCharValues(string text)
{
    var sum = 0;
    foreach (var c in text) sum += c;
    return sum;
}

// StringBuilder vs concat: shows GC pressure difference clearly in allocation profiles.
static void StringBuilderAllocation(CancellationToken ct)
{
    var iteration = 0;
    while (!ct.IsCancellationRequested)
    {
        iteration++;
        _ = iteration % 2 == 0
            ? BuildWithStringBuilder(64)
            : BuildWithConcatenation(64);
    }
}

static string BuildWithStringBuilder(int parts)
{
    var sb = new StringBuilder(parts * 8);
    for (var i = 0; i < parts; i++)
        sb.Append(System.FormattableString.Invariant($"token-{i}:"));
    return sb.ToString();
}

static string BuildWithConcatenation(int parts)
{
    var result = string.Empty;
    for (var i = 0; i < parts; i++)
        result += $"token-{i}:";
    return result;
}

static string BuildLargeJsonPayload(int entries)
{
    var sb = new StringBuilder(entries * 32);
    sb.Append('{');
    for (var i = 0; i < entries; i++)
    {
        if (i > 0) sb.Append(',');
        sb.Append(System.FormattableString.Invariant($"\"key{i}\":\"value{i}\""));
    }
    sb.Append('}');
    return sb.ToString();
}

// POSIX `getppid(2)` — available on macOS and Linux. Returns the current parent
// process id; a change signals the original parent has died and we were reparented.
internal static class NativeMethods
{
    // `DefaultDllImportSearchPaths` satisfies CA5392 (a Windows DLL-planting rule);
    // it is inert for this system libc call on the Unix platforms where the
    // watchdog actually runs (the caller no-ops on Windows). SYSLIB1054's suggested
    // LibraryImport form is declined in this fixture — it requires AllowUnsafeBlocks
    // (SYSLIB1062), not worth enabling for one getppid (suppressed in the csproj).
    [System.Runtime.InteropServices.DllImport("libc")]
    [System.Runtime.InteropServices.DefaultDllImportSearchPaths(
        System.Runtime.InteropServices.DllImportSearchPath.System32)]
    internal static extern int getppid();

    // Windows has no getppid(2); the parent PID lives in
    // PROCESS_BASIC_INFORMATION.InheritedFromUniqueProcessId, reachable only
    // via NtQueryInformationProcess (info class 0 = ProcessBasicInformation).
    [System.Runtime.InteropServices.StructLayout(
        System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [System.Runtime.InteropServices.DllImport("ntdll.dll")]
    [System.Runtime.InteropServices.DefaultDllImportSearchPaths(
        System.Runtime.InteropServices.DllImportSearchPath.System32)]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref ProcessBasicInformation processInformation,
        int processInformationLength,
        out int returnLength);

    /// <summary>Creator (parent) PID of the process behind <paramref name="processHandle"/>
    /// on Windows, or -1 when it cannot be determined.</summary>
    internal static int GetParentPid(IntPtr processHandle)
    {
        var info = default(ProcessBasicInformation);
        var status = NtQueryInformationProcess(
            processHandle,
            0,
            ref info,
            System.Runtime.InteropServices.Marshal.SizeOf<ProcessBasicInformation>(),
            out _);
        return status == 0 ? unchecked((int)info.InheritedFromUniqueProcessId.ToInt64()) : -1;
    }
}
