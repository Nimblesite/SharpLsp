// Profiler target: realistic hotspots so dotnet-trace captures named, comparable call stacks.
// Runs until killed (SIGINT/SIGTERM).

using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

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
        var reader = new Utf8JsonReader(bytes);
        while (reader.Read()) { }
    }
}

// Lock contention: multiple logical "workers" compete on a shared queue.
// Shows up as Monitor.Enter wait time vs actual work time in the flame graph.
static void LockContention(CancellationToken ct)
{
    var queue = new Queue<int>();
    var locker = new object();
    var producer = Task.Run(() =>
    {
        var i = 0;
        while (!ct.IsCancellationRequested)
        {
            lock (locker) { queue.Enqueue(i++); }
        }
    }, ct);

    while (!ct.IsCancellationRequested)
    {
        lock (locker)
        {
            if (queue.Count > 0)
                _ = queue.Dequeue();
        }
    }

    producer.Wait(TimeSpan.FromSeconds(1), CancellationToken.None);
}

// Deep named call stack so the sampler captures distinct frame names at each depth.
static void DeepCallStack(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
        ParseDocument(BuildLargeJsonPayload(64));
}

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
