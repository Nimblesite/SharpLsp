// TEMPORARY Windows named-pipe diagnostic (GitHub #110 follow-up). Isolates the
// real-NPFS hang the transport tests hit by exercising every server/client
// PipeOptions.CurrentUserOnly combination in-process, each stage watchdog-bounded
// and flushed, so the CI log shows exactly which config + stage deadlocks.
// Removed once the root cause is fixed.
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

static async Task RunConfig(bool serverCuo, bool clientCuo, int index)
{
    var name = $"probe-{index}-{Guid.NewGuid().ToString("N")[..6]}";
    Line($"CONFIG server.CurrentUserOnly={serverCuo} client.CurrentUserOnly={clientCuo} name={name}");

    var serverOptions = PipeOptions.Asynchronous | (serverCuo ? PipeOptions.CurrentUserOnly : PipeOptions.None);
    var clientOptions = PipeOptions.Asynchronous | (clientCuo ? PipeOptions.CurrentUserOnly : PipeOptions.None);

    var server = new NamedPipeServerStream(
        name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, serverOptions);
    await using var _s = server.ConfigureAwait(false);
    var client = new NamedPipeClientStream(".", name, PipeDirection.InOut, clientOptions);
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
await RunConfig(serverCuo: true, clientCuo: false, index: 1).ConfigureAwait(false);
await RunConfig(serverCuo: true, clientCuo: true, index: 2).ConfigureAwait(false);
await RunConfig(serverCuo: false, clientCuo: false, index: 3).ConfigureAwait(false);
await RunConfig(serverCuo: false, clientCuo: true, index: 4).ConfigureAwait(false);
Line("PROBE COMPLETE");
