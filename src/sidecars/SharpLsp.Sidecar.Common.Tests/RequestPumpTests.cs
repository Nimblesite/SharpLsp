using System.Threading.Channels;
using SharpLsp.Sidecar.Common.Ipc;
using WorkResult = Outcome.Result<bool, string>;

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// The sidecar's FIFO request pump in isolation: ordering, per-identity
/// cancellation and its terminal states race on real threads, which an end to
/// end session cannot pin down deterministically. [LSP-PULL-CANCELLATION]
/// </summary>
public sealed class RequestPumpTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    private static readonly WorkResult Continue = new WorkResult.Ok<bool, string>(true);

    /// <summary>A pump whose handler blocks on "block" and echoes everything else.</summary>
    private sealed class Harness : IAsyncDisposable
    {
        private readonly Channel<string> _responses = Channel.CreateUnbounded<string>();

        public Harness(
            Func<string, WorkResult>? complete = null,
            CancellationToken lifetime = default
        )
        {
            Pump = new RequestPump<string, string>(
                HandleAsync,
                (request, error) => $"failed:{request}:{error.GetType().Name}:{error.Message}",
                response =>
                {
                    _ = _responses.Writer.TryWrite(response);
                    return Task.FromResult(complete?.Invoke(response) ?? Continue);
                },
                lifetime
            );
        }

        public RequestPump<string, string> Pump { get; }

        public TaskCompletionSource Blocked { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        private async Task<string> HandleAsync(string request, CancellationToken token)
        {
            if (request == "throw")
            {
                throw new InvalidOperationException("boom");
            }
            if (request.StartsWith("block", StringComparison.Ordinal))
            {
                using var trap =
                    request == "block-trap"
                        ? token.Register(() => throw new InvalidOperationException("callback"))
                        : default;
                Blocked.SetResult();
                await Task.Delay(Timeout.Infinite, token).ConfigureAwait(false);
            }
            return $"ok:{request}";
        }

        public async Task<string> NextAsync()
        {
            using var timeout = new CancellationTokenSource(Patience);
            return await _responses.Reader.ReadAsync(timeout.Token).ConfigureAwait(false);
        }

        public async ValueTask DisposeAsync()
        {
            await Pump.DisposeAsync().ConfigureAwait(false);
        }
    }

    private static bool Value(WorkResult result)
    {
        return result.Match(value => value, error => throw new InvalidOperationException(error));
    }

    private static string Error(WorkResult result)
    {
        return result.Match(value => $"unexpected ok: {value}", error => error);
    }

    [Fact]
    public async Task Requests_run_in_order_and_cancel_only_their_own_identity()
    {
        var harness = new Harness();
        await using var lease = harness.ConfigureAwait(true);
        var pump = harness.Pump;

        // Three requests queue behind each other; a reused active id is refused.
        Assert.True(Value(pump.Enqueue(1, "block")));
        Assert.True(Value(pump.Enqueue(2, "a")));
        Assert.True(Value(pump.Enqueue(3, "b")));
        Assert.Equal("Request id is already active", Error(pump.Enqueue(2, "dup")));

        // An unknown identity is a no-op; the blocked one is cancelled alone.
        Assert.False(Value(pump.Cancel(99)));
        await harness.Blocked.Task.WaitAsync(Patience).ConfigureAwait(true);
        Assert.True(Value(pump.Cancel(1)));

        // The cancelled request answers as a failure, then the queue drains in order.
        var cancelled = await harness.NextAsync().ConfigureAwait(true);
        Assert.StartsWith(
            "failed:block:TaskCanceledException",
            cancelled,
            StringComparison.Ordinal
        );
        Assert.Equal("ok:a", await harness.NextAsync().ConfigureAwait(true));
        Assert.Equal("ok:b", await harness.NextAsync().ConfigureAwait(true));

        // Completed identities are released: cancelling one is a no-op, reusing one works.
        Assert.False(Value(pump.Cancel(2)));
        Assert.True(Value(pump.Enqueue(1, "again")));
        Assert.Equal("ok:again", await harness.NextAsync().ConfigureAwait(true));
        Assert.False(pump.Completion.IsCompleted);

        // Disposal ends the worker cleanly.
        await pump.DisposeAsync().ConfigureAwait(true);
        Assert.False(Value(await pump.Completion.ConfigureAwait(true)));
    }

    [Fact]
    public async Task A_handler_failure_is_a_response_and_a_failed_reply_stops_the_pump()
    {
        var harness = new Harness(response =>
            response == "ok:fatal" ? WorkResult.Failure("sink closed") : Continue
        );
        await using var lease = harness.ConfigureAwait(true);
        var pump = harness.Pump;

        // A throwing handler becomes that request's failure response; the pump lives on.
        Assert.True(Value(pump.Enqueue(1, "throw")));
        Assert.Equal(
            "failed:throw:InvalidOperationException:boom",
            await harness.NextAsync().ConfigureAwait(true)
        );
        Assert.True(Value(pump.Enqueue(2, "next")));
        Assert.Equal("ok:next", await harness.NextAsync().ConfigureAwait(true));
        Assert.False(pump.Completion.IsCompleted);

        // A reply the host cannot flush is terminal and reported, not swallowed.
        Assert.True(Value(pump.Enqueue(3, "fatal")));
        Assert.Equal("ok:fatal", await harness.NextAsync().ConfigureAwait(true));
        var completion = await pump.Completion.WaitAsync(Patience).ConfigureAwait(true);
        Assert.Equal("sink closed", Error(completion));
    }

    [Fact]
    public async Task A_throwing_reply_or_cancellation_callback_is_a_result_never_a_crash()
    {
        var harness = new Harness(response =>
            response == "ok:explode" ? throw new IOException("pipe gone") : Continue
        );
        await using var lease = harness.ConfigureAwait(true);
        var pump = harness.Pump;

        // A cancellation callback that throws is the cancel's failure; the request still ends.
        Assert.True(Value(pump.Enqueue(5, "block-trap")));
        await harness.Blocked.Task.WaitAsync(Patience).ConfigureAwait(true);
        Assert.Contains("callback", Error(pump.Cancel(5)), StringComparison.Ordinal);
        Assert.StartsWith(
            "failed:block-trap:TaskCanceledException",
            await harness.NextAsync().ConfigureAwait(true),
            StringComparison.Ordinal
        );
        Assert.False(pump.Completion.IsCompleted);

        // A reply that throws ends the worker with the exception's message.
        Assert.True(Value(pump.Enqueue(1, "explode")));
        Assert.Equal("ok:explode", await harness.NextAsync().ConfigureAwait(true));
        var completion = await pump.Completion.WaitAsync(Patience).ConfigureAwait(true);
        Assert.Equal("pipe gone", Error(completion));
    }

    [Fact]
    public async Task The_lifetime_cancels_active_work_and_completes_cleanly()
    {
        using var lifetime = new CancellationTokenSource();
        var harness = new Harness(lifetime: lifetime.Token);
        await using var lease = harness.ConfigureAwait(true);
        var pump = harness.Pump;

        Assert.True(Value(pump.Enqueue(1, "block")));
        Assert.True(Value(pump.Enqueue(2, "queued")));
        await harness.Blocked.Task.WaitAsync(Patience).ConfigureAwait(true);

        // Host shutdown cancels the active request and stops before queued work.
        await lifetime.CancelAsync().ConfigureAwait(true);
        Assert.StartsWith(
            "failed:block:TaskCanceledException",
            await harness.NextAsync().ConfigureAwait(true),
            StringComparison.Ordinal
        );
        var completion = await pump.Completion.WaitAsync(Patience).ConfigureAwait(true);
        Assert.False(Value(completion));
        Assert.True(pump.Completion.IsCompletedSuccessfully);
    }
}
