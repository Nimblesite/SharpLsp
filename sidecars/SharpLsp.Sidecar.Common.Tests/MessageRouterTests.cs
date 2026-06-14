using System.Globalization;
using Serilog;
using Serilog.Core;
using Serilog.Events;
using SharpLsp.Sidecar.Common.Ipc;
using SharpLsp.Sidecar.Common.Messages;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.Common.Tests;

public sealed class MessageRouterTests
{
    /// <summary>Captures rendered log messages emitted while it is the active sink.</summary>
    private sealed class CapturingSink : ILogEventSink
    {
        public List<string> Messages { get; } = [];

        public void Emit(LogEvent logEvent)
        {
            Messages.Add(logEvent.RenderMessage(CultureInfo.InvariantCulture));
        }
    }

    private static MessageRouter EchoRouter()
    {
        var router = new MessageRouter();
        router.Register(
            "echo",
            (payload, _) => Task.FromResult<ByteResult>(new ByteResult.Ok<byte[], string>(payload))
        );
        return router;
    }

    [Fact]
    public async Task HandleAsync_routes_request_tracing_through_structured_logging()
    {
        // Regression guard for issue #78: routine per-request handling is logged
        // via Serilog (a rolling file), not dumped to stderr / the Output panel.
        var sink = new CapturingSink();
        var original = Log.Logger;
        Log.Logger = new LoggerConfiguration()
            .MinimumLevel.Debug()
            .WriteTo.Sink(sink)
            .CreateLogger();
        try
        {
            var router = EchoRouter();
            var request = new Envelope
            {
                Id = 1,
                Method = "echo",
                Payload = [1, 2, 3],
            };
            _ = await router.HandleAsync(request).ConfigureAwait(true);
        }
        finally
        {
            (Log.Logger as IDisposable)?.Dispose();
            Log.Logger = original;
        }

        Assert.Contains(
            sink.Messages,
            message =>
                message.Contains("[Router]", StringComparison.Ordinal)
                && message.Contains("echo", StringComparison.Ordinal)
        );
    }

    [Fact]
    public async Task HandleAsync_returns_the_handler_payload()
    {
        var router = EchoRouter();
        var request = new Envelope
        {
            Id = 7,
            Method = "echo",
            Payload = [9, 9],
        };

        var response = await router.HandleAsync(request).ConfigureAwait(true);

        Assert.NotNull(response);
        Assert.Equal((uint)7, response!.Id);
        Assert.Equal(request.Payload, response.Payload);
        Assert.Null(response.Error);
    }

    [Fact]
    public void Register_throws_when_a_method_is_registered_twice()
    {
        var router = EchoRouter();

        _ = Assert.Throws<InvalidOperationException>(() =>
            router.Register(
                "echo",
                (payload, _) =>
                    Task.FromResult<ByteResult>(new ByteResult.Ok<byte[], string>(payload))
            )
        );
    }

    [Fact]
    public async Task SendRequestAsync_correlates_a_response_to_its_pending_request()
    {
        var router = new MessageRouter();
        using var stream = new MemoryStream();
        var transport = new FramedTransport(stream);
        await using (transport.ConfigureAwait(false))
        {
            // Begin a request (id 1) without awaiting; it parks a pending completion.
            var pending = router.SendRequestAsync(transport, "echo", [1, 2, 3]);

            // An id-only envelope is a response — HandleAsync routes it to the
            // pending request and completes it.
            var responseEnvelope = new Envelope { Id = 1, Payload = [4, 5, 6] };
            _ = await router.HandleAsync(responseEnvelope).ConfigureAwait(true);

            var result = await pending.ConfigureAwait(true);
            var payload = Assert.IsType<ByteResult.Ok<byte[], string>>(result).Value;
            Assert.Equal(responseEnvelope.Payload, payload);
        }
    }
}
