using System.Collections.Concurrent;
using Forge.Sidecar.Common.Messages;
using MessagePack;

namespace Forge.Sidecar.Common.Ipc;

/// <summary>
/// Dispatches incoming requests by method name and correlates responses by ID.
/// </summary>
public sealed class MessageRouter
{
    private readonly ConcurrentDictionary<string, Func<byte[], CancellationToken, Task<byte[]>>>
        _handlers = new();

    private readonly ConcurrentDictionary<uint, TaskCompletionSource<Envelope>>
        _pending = new();

    private uint _nextId;

    /// <summary>Register a handler for a given method name.</summary>
    public void Register(string method, Func<byte[], CancellationToken, Task<byte[]>> handler)
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

    /// <summary>Send a request and await the response.</summary>
    public async Task<byte[]> SendRequestAsync(
        FramedTransport transport,
        string method,
        byte[] payload,
        CancellationToken ct = default)
    {
        var id = Interlocked.Increment(ref _nextId);
        var tcs = new TaskCompletionSource<Envelope>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;

        var request = new Envelope { Id = id, Method = method, Payload = payload };
        var bytes = MessagePackSerializer.Serialize(request, cancellationToken: ct);
        await transport.WriteFrameAsync(bytes, ct).ConfigureAwait(false);

        await using (ct.Register(() => tcs.TrySetCanceled(ct)))
        {
            var response = await tcs.Task.ConfigureAwait(false);
            if (response.Error is not null)
            {
                throw new InvalidOperationException($"Sidecar error: {response.Error}");
            }

            return response.Payload;
        }
    }

    private async Task<Envelope> HandleRequestAsync(Envelope request, CancellationToken ct)
    {
        if (!_handlers.TryGetValue(request.Method!, out var handler))
        {
            return new Envelope
            {
                Id = request.Id,
                Error = $"Unknown method: {request.Method}",
            };
        }

        try
        {
            var result = await handler(request.Payload, ct).ConfigureAwait(false);
            return new Envelope { Id = request.Id, Payload = result };
        }
        catch (Exception ex)
        {
            return new Envelope { Id = request.Id, Error = ex.Message };
        }
    }

    private void HandleResponse(Envelope response)
    {
        if (response.Id is not null && _pending.TryRemove(response.Id.Value, out var tcs))
        {
            tcs.TrySetResult(response);
        }
    }
}
