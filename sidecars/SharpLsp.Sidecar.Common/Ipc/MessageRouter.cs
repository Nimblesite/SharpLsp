using System.Collections.Concurrent;
using MessagePack;
using Serilog;
using SharpLsp.Sidecar.Common.Messages;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.Common.Ipc;

/// <summary>
/// Dispatches incoming requests by method name and correlates responses by ID.
/// </summary>
public sealed class MessageRouter
{
    private readonly ConcurrentDictionary<
        string,
        Func<byte[], CancellationToken, Task<ByteResult>>
    > _handlers = new();

    private readonly ConcurrentDictionary<uint, TaskCompletionSource<Envelope>> _pending = new();

    private uint _nextId;

    /// <summary>Register a handler for a given method name.</summary>
    public void Register(string method, Func<byte[], CancellationToken, Task<ByteResult>> handler)
    {
        if (!_handlers.TryAdd(method, handler))
        {
            throw new InvalidOperationException($"Handler already registered for '{method}'.");
        }
    }

    /// <summary>
    /// Process an incoming envelope. Returns a response envelope for requests,
    /// or null for responses/notifications.
    /// </summary>
    public async Task<Envelope?> HandleAsync(Envelope envelope, CancellationToken ct = default)
    {
        try
        {
            if (envelope.Method is not null && envelope.Id is not null)
            {
                return await HandleRequestAsync(envelope, ct).ConfigureAwait(false);
            }

            if (envelope.Id is not null)
            {
                HandleResponse(envelope);
            }

            return null;
        }
        catch (Exception ex)
        {
            Log.Error(ex, "Router failed to handle envelope (id={Id})", envelope.Id);
            return envelope.Id is not null
                ? new Envelope { Id = envelope.Id, Error = ex.Message }
                : null;
        }
    }

    /// <summary>Send a request and await the response.</summary>
    public async Task<ByteResult> SendRequestAsync(
        FramedTransport transport,
        string method,
        byte[] payload,
        CancellationToken ct = default
    )
    {
        try
        {
            return await SendAndAwaitAsync(transport, method, payload, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> SendAndAwaitAsync(
        FramedTransport transport,
        string method,
        byte[] payload,
        CancellationToken ct
    )
    {
        var id = Interlocked.Increment(ref _nextId);
        var tcs = new TaskCompletionSource<Envelope>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        _pending[id] = tcs;

        var request = new Envelope
        {
            Id = id,
            Method = method,
            Payload = payload,
        };
        var bytes = MessagePackSerializer.Serialize(request, cancellationToken: ct);
        await transport.WriteFrameAsync(bytes, ct).ConfigureAwait(false);

        await using (ct.Register(() => tcs.TrySetCanceled(ct)))
        {
            var response = await tcs.Task.ConfigureAwait(false);
            return response.Error is not null
                ? ByteResult.Failure($"Sidecar error: {response.Error}")
                : new ByteResult.Ok<byte[], string>(response.Payload);
        }
    }

    private async Task<Envelope> HandleRequestAsync(Envelope request, CancellationToken ct)
    {
        if (!_handlers.TryGetValue(request.Method!, out var handler))
        {
            Log.Warning("[Router] Unknown method: {Method}", request.Method);
            return new Envelope { Id = request.Id, Error = $"Unknown method: {request.Method}" };
        }

        try
        {
            Log.Debug("[Router] Handling {Method} (id={Id})", request.Method, request.Id);
            var result = await handler(request.Payload, ct).ConfigureAwait(false);
            return result.Match(
                payload =>
                {
                    Log.Debug(
                        "[Router] {Method} (id={Id}) => OK ({Bytes} bytes)",
                        request.Method,
                        request.Id,
                        payload.Length
                    );
                    return new Envelope { Id = request.Id, Payload = payload };
                },
                error =>
                {
                    Log.Debug(
                        "[Router] {Method} (id={Id}) => Error: {Error}",
                        request.Method,
                        request.Id,
                        error
                    );
                    return new Envelope { Id = request.Id, Error = error };
                }
            );
        }
        catch (Exception ex)
        {
            Log.Error(ex, "[Router] {Method} (id={Id}) threw", request.Method, request.Id);
            return new Envelope { Id = request.Id, Error = ex.Message };
        }
    }

    private void HandleResponse(Envelope response)
    {
        if (response.Id is not null && _pending.TryRemove(response.Id.Value, out var tcs))
        {
            _ = tcs.TrySetResult(response);
        }
    }
}
