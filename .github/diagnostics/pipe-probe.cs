// TEMPORARY Windows named-pipe diagnostic (GitHub #110 follow-up). The transport
// tests deadlocked at the first pipe WRITE on real NPFS: a pipe created with the
// default 0-byte buffers blocks WriteFile until a read is posted. This probe
// confirms that giving the pipe an explicit buffer removes the deadlock, by
// contrasting a 0-buffer server (expected HANG at write) with a buffered one
// (expected OK). Per-stage watchdogs + flushed output. Removed once fixed.
#:property RunAnalyzers=false
#:property EnableNETAnalyzers=false
#:property EnforceExtendedAnalyzerRules=false
#:property EnforceCodeStyleInBuild=false
#:property TreatWarningsAsErrors=false
using System.Diagnostics;
using System.IO.Pipes;

static void Line(string s)
{
    Console.WriteLine(s);
    Console.Out.Flush();
}

static async Task<bool> Stage(string name, Func<Task> body)
{
    var sw = Stopwatch.StartNew();
    var task = body();
    var done = await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(6))).ConfigureAwait(false);
    if (done != task)
    {
        Line($"    HANG  [{name}] (>6s)");
        return false;
    }

    try
    {
        await task.ConfigureAwait(false);
        Line($"    ok    [{name}] {sw.ElapsedMilliseconds}ms");
        return true;
    }
    catch (Exception ex)
    {
        Line($"    throw [{name}] {ex.GetType().Name}: {ex.Message}");
        return false;
    }
}

static async Task RunConfig(int bufferSize, int index)
{
    var name = $"probe-{index}-{Guid.NewGuid().ToString("N")[..6]}";
    Line($"CONFIG bufferSize={bufferSize} name={name}");

    var options = PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly;
    var server = bufferSize == 0
        ? new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, options)
        : new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, options, bufferSize, bufferSize);
    await using var _s = server.ConfigureAwait(false);
    var client = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
    await using var _c = client.ConfigureAwait(false);

    Task? acceptTask = null;
    if (!await Stage("start-accept", () => { acceptTask = server.WaitForConnectionAsync(); return Task.CompletedTask; }).ConfigureAwait(false)) return;
    using var connectCts = new CancellationTokenSource(TimeSpan.FromSeconds(6));
    if (!await Stage("client-connect", () => client.ConnectAsync(connectCts.Token)).ConfigureAwait(false)) return;
    if (!await Stage("await-accept", () => acceptTask!).ConfigureAwait(false)) return;
    if (!await Stage("write-ping", () => client.WriteAsync("ping"u8.ToArray()).AsTask()).ConfigureAwait(false)) return;
    if (!await Stage("read-ping", async () =>
    {
        var buf = new byte[4];
        _ = await server.ReadAsync(buf).ConfigureAwait(false);
    }).ConfigureAwait(false)) return;
    Line("    CONFIG OK");
}

Line($"OSVersion: {Environment.OSVersion}");
await RunConfig(bufferSize: 0, index: 1).ConfigureAwait(false);       // control: expected HANG at write
await RunConfig(bufferSize: 64 * 1024, index: 2).ConfigureAwait(false); // fix: expected CONFIG OK
Line("PROBE COMPLETE");
