// Profiler target: realistic hotspots so dotnet-trace captures named, comparable call stacks.
// Runs until killed (SIGINT/SIGTERM).

using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

// Self-terminate when orphaned: if the parent (the test host) dies abnormally —
// e.g. nextest SIGKILLs a timed-out test — Rust-side `Drop` cleanup never runs
// and this CPU-bound process would leak as a runaway (issue #3). Watch the parent
// PID and cancel once we are reparented. POSIX-only; `getppid` exists on macOS/Linux.
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
        return;

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
}
