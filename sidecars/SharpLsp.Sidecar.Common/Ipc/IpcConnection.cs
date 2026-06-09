using System.Security.Cryptography;
using System.Text;
using ListenerResult = Outcome.Result<SharpLsp.Sidecar.Common.Ipc.IpcListener, string>;
using StreamResult = Outcome.Result<System.IO.Stream, string>;
#if WINDOWS
using System.IO.Pipes;
#else
using System.Net.Sockets;
#endif

namespace SharpLsp.Sidecar.Common.Ipc;

/// <summary>Platform listener for sidecar IPC.</summary>
public sealed class IpcListener : IAsyncDisposable
{
#if WINDOWS
    private readonly NamedPipeServerStream _pipe;

    private IpcListener(NamedPipeServerStream pipe)
    {
        _pipe = pipe;
    }
#else
    private readonly Socket _socket;

    private IpcListener(Socket socket)
    {
        _socket = socket;
    }
#endif

    /// <summary>Create a listener for the platform endpoint.</summary>
    public static IpcListener Create(string endpoint)
    {
#if WINDOWS
        return new IpcListener(CreateNamedPipe(endpoint));
#else
        return new IpcListener(CreateUnixSocket(endpoint));
#endif
    }

    /// <summary>Accept one sidecar IPC connection as a stream.</summary>
    public async Task<Stream> AcceptStreamAsync(CancellationToken ct = default)
    {
#if WINDOWS
        await _pipe.WaitForConnectionAsync(ct).ConfigureAwait(false);
        return _pipe;
#else
        var client = await _socket.AcceptAsync(ct).ConfigureAwait(false);
        return new NetworkStream(client, ownsSocket: true);
#endif
    }

    /// <summary>Dispose the underlying listener.</summary>
    public ValueTask DisposeAsync()
    {
#if WINDOWS
        return _pipe.DisposeAsync();
#else
        _socket.Dispose();
        return ValueTask.CompletedTask;
#endif
    }

#if WINDOWS
    private static NamedPipeServerStream CreateNamedPipe(string endpoint)
    {
        return new NamedPipeServerStream(
            IpcConnection.PipeName(endpoint),
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous
        );
    }
#else
    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Socket ownership transfers to IpcListener"
    )]
    private static Socket CreateUnixSocket(string endpoint)
    {
        var effectivePath = IpcConnection.ShortenIfNeeded(endpoint);
        if (File.Exists(effectivePath))
        {
            File.Delete(effectivePath);
        }

        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            socket.Bind(new UnixDomainSocketEndPoint(effectivePath));
            socket.Listen(1);
            RestrictSocketToOwner(effectivePath);
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Restrict the just-bound Unix domain socket to owner-only access (0600).
    /// The socket path is deterministic and lives in a shared temp directory, so
    /// without this a co-located local user could predict the path and connect
    /// to the unauthenticated sidecar IPC channel. This is a same-user hardening
    /// measure, not a cross-trust-boundary fix.
    /// </summary>
    private static void RestrictSocketToOwner(string socketPath)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        File.SetUnixFileMode(socketPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
#endif
}

/// <summary>
/// Creates platform IPC connections for sidecars.
/// </summary>
public static class IpcConnection
{
    /// <summary>
    /// Generate a deterministic socket path from a workspace root.
    /// Format: /tmp/sharplsp-{hash8}.sock (stays under 108-char Unix limit).
    /// </summary>
    public static string GenerateSocketPath(string workspaceRoot)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(workspaceRoot));
        var hex = Convert.ToHexString(hash).AsSpan(0, 8);
#if WINDOWS
        return $@"\\.\pipe\sharplsp-{hex}";
#else
        return Path.Combine(Path.GetTempPath(), $"sharplsp-{hex}.sock");
#endif
    }

    /// <summary>Start listening on the platform IPC endpoint.</summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Listener ownership transfers to caller via Result"
    )]
    public static ListenerResult CreateListener(string socketPath)
    {
        try
        {
            return new ListenerResult.Ok<IpcListener, string>(IpcListener.Create(socketPath));
        }
        catch (Exception ex)
        {
            return ListenerResult.Failure(ex.Message);
        }
    }

    /// <summary>Connect to an existing platform IPC endpoint.</summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Stream ownership transfers to caller via Result"
    )]
    public static async Task<StreamResult> ConnectAsync(
        string socketPath,
        CancellationToken ct = default
    )
    {
        try
        {
            return new StreamResult.Ok<Stream, string>(
                await ConnectCoreAsync(socketPath, ct).ConfigureAwait(false)
            );
        }
        catch (Exception ex)
        {
            return StreamResult.Failure(ex.Message);
        }
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Stream ownership transfers to caller via Result"
    )]
    private static async Task<Stream> ConnectCoreAsync(string socketPath, CancellationToken ct)
    {
#if WINDOWS
        var pipe = new NamedPipeClientStream(
            ".",
            IpcConnection.PipeName(socketPath),
            PipeDirection.InOut,
            PipeOptions.Asynchronous
        );
        await pipe.ConnectAsync(ct).ConfigureAwait(false);
        return pipe;
#else
        var effectivePath = ShortenIfNeeded(socketPath);
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            await socket
                .ConnectAsync(new UnixDomainSocketEndPoint(effectivePath), ct)
                .ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
#endif
    }

    /// <summary>
    /// Unix domain sockets have a 108-char path limit. If the path exceeds
    /// this, relocate to a temp directory using a hash of the original path.
    /// </summary>
    internal static string ShortenIfNeeded(string socketPath)
    {
        const int unixSocketPathLimit = 107;
        if (socketPath.Length <= unixSocketPathLimit)
        {
            return socketPath;
        }

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(socketPath));
        var hex = Convert.ToHexString(hash).AsSpan(0, 16);
        return Path.Combine(Path.GetTempPath(), $"sharplsp-{hex}.sock");
    }

    internal static string PipeName(string endpoint)
    {
        const string prefix = @"\\.\pipe\";
        return endpoint.StartsWith(prefix, StringComparison.Ordinal)
            ? endpoint[prefix.Length..]
            : throw new ArgumentException("Windows IPC endpoint must be a named pipe path");
    }
}
