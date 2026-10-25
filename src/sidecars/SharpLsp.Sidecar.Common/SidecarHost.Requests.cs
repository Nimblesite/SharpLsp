using LspKit.Sidecar;
using MessagePack;
using Serilog;
using SharpLsp.Sidecar.Common.Ipc;
using SharpLsp.Sidecar.Common.Messages;
using ReadResult = Outcome.Result<bool, System.Exception>;
using WorkResult = Outcome.Result<bool, string>;

namespace SharpLsp.Sidecar.Common;

public abstract partial class SidecarHost
{
    // [DIAG-ANALYSIS-CANCELLATION]: socket reads remain independent of compiler work.
    private async Task RunRequestsAsync(FramedTransport transport)
    {
        var requests = CreateRequests(transport);
        await using var requestScope = requests.ConfigureAwait(false);
        var failures = 0;
        while (
            !_shutdownCts.IsCancellationRequested
            && ContinueLoop(
                await TryProcessMessageAsync(transport, requests).ConfigureAwait(false),
                ref failures
            )
        ) { }
    }

    private RequestPump<Envelope, Envelope?> CreateRequests(FramedTransport transport)
    {
        return new RequestPump<Envelope, Envelope?>(
            _router.HandleAsync,
            (request, error) => new Envelope { Id = request.Id, Error = error.Message },
            response => CompleteRequestAsync(transport, response),
            _shutdownCts.Token
        );
    }

    private static bool ContinueLoop(ReadResult result, ref int failures)
    {
        if (!result.IsError)
        {
            failures = 0;
            return result.Match(value => value, _ => false);
        }
        return ContinueAfterFailure(!result, ref failures);
    }

    private static bool ContinueAfterFailure(Exception error, ref int failures)
    {
        if (error is IOException or ObjectDisposedException)
        {
            Log.Error(error, "Sidecar transport failed; ending message loop");
            return false;
        }
        Log.Error(error, "Sidecar message loop error");
        if (++failures >= MaxConsecutiveMessageFailures)
        {
            Log.Fatal("Sidecar message loop aborting after {Count} consecutive failures", failures);
        }
        return failures < MaxConsecutiveMessageFailures;
    }

    private async Task<ReadResult> TryProcessMessageAsync(
        FramedTransport transport,
        RequestPump<Envelope, Envelope?> requests
    )
    {
        try
        {
            var message = ProcessOneMessageAsync(transport, requests, _shutdownCts.Token);
            return new ReadResult.Ok<bool, Exception>(await message.ConfigureAwait(false));
        }
        catch (OperationCanceledException)
        {
            return new ReadResult.Ok<bool, Exception>(false);
        }
        catch (Exception error)
        {
            return ReadResult.Failure(error);
        }
    }

    private async Task<bool> ProcessOneMessageAsync(
        FramedTransport transport,
        RequestPump<Envelope, Envelope?> requests,
        CancellationToken ct
    )
    {
        var frame = await ReadOrCompleteAsync(transport, requests, ct).ConfigureAwait(false);
        if (frame is null)
        {
            return false;
        }
        var envelope = MessagePackSerializer.Deserialize<Envelope>(frame, cancellationToken: ct);
        return await AcceptEnvelopeAsync(envelope, requests, ct).ConfigureAwait(false);
    }

    private async Task<bool> AcceptEnvelopeAsync(
        Envelope envelope,
        RequestPump<Envelope, Envelope?> requests,
        CancellationToken ct
    )
    {
        if (envelope.Method == "$/cancelRequest" && envelope.Id is null)
        {
            CancelRequest(requests, envelope, ct);
            return true;
        }
        if (envelope.Id is { } id && envelope.Method is not null)
        {
            return EnqueueRequest(requests, id, envelope);
        }
        _ = await _router.HandleAsync(envelope, ct).ConfigureAwait(false);
        return true;
    }

    private static bool EnqueueRequest(
        RequestPump<Envelope, Envelope?> requests,
        uint id,
        Envelope envelope
    )
    {
        var accepted = requests.Enqueue(id, envelope);
        if (accepted.IsError)
        {
            Log.Warning("Sidecar request registration failed for {Id}", id);
        }
        return !accepted.IsError;
    }

    private static void CancelRequest(
        RequestPump<Envelope, Envelope?> requests,
        Envelope envelope,
        CancellationToken ct
    )
    {
        var id = MessagePackSerializer.Deserialize<uint>(envelope.Payload, cancellationToken: ct);
        if (requests.Cancel(id).IsError)
        {
            Log.Warning("Request cancellation failed for {Id}", id);
        }
    }

    private static async Task<byte[]?> ReadOrCompleteAsync(
        FramedTransport transport,
        RequestPump<Envelope, Envelope?> requests,
        CancellationToken ct
    )
    {
        using var reading = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var frame = transport.ReadFrameAsync(reading.Token);
        if (
            await Task.WhenAny(frame, requests.Completion).ConfigureAwait(false)
            != requests.Completion
        )
        {
            return await frame.ConfigureAwait(false);
        }
        await CompleteReaderAsync(requests.Completion, reading, frame).ConfigureAwait(false);
        return null;
    }

    private static async Task CompleteReaderAsync(
        Task<WorkResult> completion,
        CancellationTokenSource reading,
        Task<byte[]?> frame
    )
    {
        var complete = await completion.ConfigureAwait(false);
        if (complete.IsError)
        {
            Log.Warning("Sidecar request worker failed");
        }
        await CancelReaderAsync(reading, frame).ConfigureAwait(false);
    }

    private static async Task CancelReaderAsync(
        CancellationTokenSource reading,
        Task<byte[]?> frame
    )
    {
        await reading.CancelAsync().ConfigureAwait(false);
        try
        {
            _ = await frame.ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (reading.IsCancellationRequested) { }
    }

    private async Task<WorkResult> CompleteRequestAsync(
        FramedTransport transport,
        Envelope? response
    )
    {
        try
        {
            if (response is not null)
            {
                await WriteResponseAsync(transport, response, _shutdownCts.Token)
                    .ConfigureAwait(false);
            }
            return new WorkResult.Ok<bool, string>(!_stopRequested);
        }
        catch (Exception error)
        {
            return WorkResult.Failure(error.Message);
        }
    }
}
