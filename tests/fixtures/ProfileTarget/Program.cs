// Profiler target: continuous CPU + GC activity so dotnet-trace captures real data.
// Runs until killed (SIGINT/SIGTERM).

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

Console.WriteLine("READY");
await Console.Out.FlushAsync().ConfigureAwait(false);

var tasks = new[]
{
    Task.Run(() => CpuWork(cts.Token), cts.Token),
    Task.Run(() => AllocationWork(cts.Token), cts.Token),
    Task.Run(() => RecursiveWork(cts.Token), cts.Token),
};

try { await Task.WhenAll(tasks).ConfigureAwait(false); }
catch (OperationCanceledException) { }

// Tight CPU loop — deterministic seed, not security-sensitive.
static void CpuWork(CancellationToken ct)
{
    double acc = 1.0;
    var step = 0;
    while (!ct.IsCancellationRequested)
    {
        step++;
        acc = Math.Sin(acc + step) * Math.Cos(acc * 0.001);
        if (step % 100_000 == 0)
            GC.KeepAlive(acc);
    }
}

// Continuous short-lived allocations to trigger GC collections.
static void AllocationWork(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        var buf = new byte[1024 * 4];
        buf[0] = 1;
        _ = string.Join(",", Enumerable.Range(0, 128).Select(i => $"item-{i}"));
        Thread.Sleep(1);
    }
}

// Recursive calls give the CPU sampler a deep call stack to record.
static void RecursiveWork(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        Fibonacci(28);
        Thread.Sleep(5);
    }
}

static long Fibonacci(int n) => n <= 1 ? n : Fibonacci(n - 1) + Fibonacci(n - 2);
