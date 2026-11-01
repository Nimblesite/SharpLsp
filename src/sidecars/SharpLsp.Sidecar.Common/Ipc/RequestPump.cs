using System.Collections.Concurrent;
using System.Threading.Channels;
using WorkResult = Outcome.Result<bool, string>;

namespace SharpLsp.Sidecar.Common.Ipc;

/// <summary>FIFO execution with cancellation registration before scheduling. [LSP-PULL-CANCELLATION]</summary>
public sealed class RequestPump<TRequest, TResponse> : IAsyncDisposable
{
    private sealed record Call(uint Id, TRequest Request, CancellationTokenSource Source);

    private readonly Channel<Call> _queue = Channel.CreateUnbounded<Call>();
    private readonly ConcurrentDictionary<uint, CancellationTokenSource> _pending = new();
    private readonly CancellationTokenSource _lifetime;
    private int _disposed;
    private readonly Func<TRequest, CancellationToken, Task<TResponse>> _handle;
    private readonly Func<TRequest, Exception, TResponse> _failure;
    private readonly Func<TResponse, Task<WorkResult>> _complete;

    /// <summary>The reader remains independent of synchronous compiler work in the FIFO worker.</summary>
    public RequestPump(
        Func<TRequest, CancellationToken, Task<TResponse>> handle,
        Func<TRequest, Exception, TResponse> failure,
        Func<TResponse, Task<WorkResult>> complete,
        CancellationToken lifetime
    )
    {
        _handle = handle;
        _failure = failure;
        _complete = complete;
        _lifetime = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
        Completion = Task.Run(RunAsync);
    }

    /// <summary>Completes only after a terminal reply has been flushed or a fatal failure occurs.</summary>
    public Task<WorkResult> Completion { get; }

    /// <summary>Register before enqueueing so a following cancellation cannot overtake registration.</summary>
    public WorkResult Enqueue(uint id, TRequest request)
    {
        var source = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        if (!_pending.TryAdd(id, source))
        {
            source.Dispose();
            return WorkResult.Failure("Request id is already active");
        }
        if (_queue.Writer.TryWrite(new Call(id, request, source)))
        {
            return new WorkResult.Ok<bool, string>(true);
        }
        Remove(id, source);
        return WorkResult.Failure("Request queue is closed");
    }

    /// <summary>Unknown and completed request identities never affect another request.</summary>
    public WorkResult Cancel(uint id)
    {
        if (!_pending.TryGetValue(id, out var source))
        {
            return new WorkResult.Ok<bool, string>(false);
        }
        try
        {
            source.Cancel();
            return new WorkResult.Ok<bool, string>(true);
        }
        catch (ObjectDisposedException)
        {
            return new WorkResult.Ok<bool, string>(false);
        }
        // A cancellation callback threw; Cancel aggregates every callback failure.
        catch (AggregateException error)
        {
            return WorkResult.Failure(error.Message);
        }
    }

    private async Task<WorkResult> RunAsync()
    {
        try
        {
            return await RunQueuedAsync().ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
            return new WorkResult.Ok<bool, string>(false);
        }
        // The worker boundary: any failure becomes a result, except the runtime's own fatal states.
        catch (Exception error) when (error is not (OutOfMemoryException or StackOverflowException))
        {
            return WorkResult.Failure(error.Message);
        }
    }

    private async Task<WorkResult> RunQueuedAsync()
    {
        await foreach (
            var call in _queue.Reader.ReadAllAsync(_lifetime.Token).ConfigureAwait(false)
        )
        {
            var response = await InvokeAsync(call).ConfigureAwait(false);
            var result = await _complete(response).ConfigureAwait(false);
            if (!result.Match(value => value, _ => false))
            {
                return result;
            }
        }
        return new WorkResult.Ok<bool, string>(false);
    }

    private async Task<TResponse> InvokeAsync(Call call)
    {
        try
        {
            return await _handle(call.Request, call.Source.Token).ConfigureAwait(false);
        }
        // A handler failure is the request's failure response, never the pump's.
        catch (Exception error) when (error is not (OutOfMemoryException or StackOverflowException))
        {
            return _failure(call.Request, error);
        }
        // Remove before terminal emission: a completed identity can be reused immediately.
        finally
        {
            Remove(call.Id, call.Source);
        }
    }

    private void Remove(uint id, CancellationTokenSource source)
    {
        _ = _pending.TryRemove(id, out _);
        source.Dispose();
    }

    /// <summary>Cancel active and queued work, observe the worker, and release all registrations.</summary>
    public async ValueTask DisposeAsync()
    {
        // Idempotent, as IAsyncDisposable requires: a second call has nothing to release.
        if (Interlocked.Exchange(ref _disposed, 1) == 1)
        {
            return;
        }
        _ = _queue.Writer.TryComplete();
        await _lifetime.CancelAsync().ConfigureAwait(false);
        _ = await Completion.ConfigureAwait(false);
        foreach (var source in _pending.Values)
        {
            source.Dispose();
        }
        _pending.Clear();
        _lifetime.Dispose();
        GC.SuppressFinalize(this);
    }
}
