using System.IO.Pipes;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using ListenerResult = Outcome.Result<SharpLsp.Sidecar.Common.Ipc.IpcListener, string>;
using StreamResult = Outcome.Result<System.IO.Stream, string>;

namespace SharpLsp.Sidecar.Common.Ipc;

/// <summary>Platform listener for sidecar IPC.</summary>
public sealed class IpcListener : IAsyncDisposable
{
    // Exactly one transport is set, chosen at runtime from the endpoint shape.
    // The sidecars ship as a single platform-neutral assembly in every VSIX
    // ([DIST-VSIX-LAYOUT]), so the transport can never be a compile-time
    // decision. Implements [DIST-CI-WIN-TRANSPORT] (GitHub #110).
    private readonly NamedPipeServerStream? _pipe;
    private readonly Socket? _socket;

    private IpcListener(NamedPipeServerStream pipe, string boundEndpoint)
    {
        _pipe = pipe;
        BoundEndpoint = boundEndpoint;
    }

    private IpcListener(Socket socket, string boundEndpoint)
    {
        _socket = socket;
        BoundEndpoint = boundEndpoint;
    }

    /// <summary>
    /// The endpoint the listener actually bound. For an overlong Unix path this
    /// differs from the requested endpoint because it is relocated to a hashed
    /// temp path; READY MUST advertise this value, since the Rust host connects
    /// to the echoed path verbatim with no shortening counterpart (GitHub #154,
    /// [DIST-CI-WIN-TRANSPORT]).
    /// </summary>
    public string BoundEndpoint { get; }

    /// <summary>Create a listener for the endpoint's transport.</summary>
    public static IpcListener Create(string endpoint)
    {
        if (IpcConnection.IsPipeEndpoint(endpoint))
        {
            return new IpcListener(CreateNamedPipe(endpoint), endpoint);
        }

        var boundPath = IpcConnection.ShortenIfNeeded(endpoint);
        return new IpcListener(CreateUnixSocket(boundPath), boundPath);
    }

    /// <summary>Accept one sidecar IPC connection as a stream.</summary>
    public async Task<Stream> AcceptStreamAsync(CancellationToken ct = default)
    {
        if (_pipe is not null)
        {
            await _pipe.WaitForConnectionAsync(ct).ConfigureAwait(false);
            return _pipe;
        }

        var client = await _socket!.AcceptAsync(ct).ConfigureAwait(false);
        return new NetworkStream(client, ownsSocket: true);
    }

    /// <summary>Dispose the underlying listener.</summary>
    public ValueTask DisposeAsync()
    {
        if (_pipe is not null)
        {
            return _pipe.DisposeAsync();
        }

        _socket!.Dispose();
        return ValueTask.CompletedTask;
    }

    // A Windows named pipe created with the default 0-byte buffers blocks every
    // write until the peer posts a read (WriteFile waits for a reader), which
    // deadlocks the request/response handshake before the first read is pending.
    // Unix domain sockets buffer by default, so this only bites on Windows.
    // 64 KiB matches a typical pipe buffer and keeps normal frames non-blocking;
    // larger frames still stream correctly against the always-pending reader in
    // the message loop. (GitHub #110 — surfaced by the Windows transport CI.)
    private const int PipeBufferSize = 64 * 1024;

    private static NamedPipeServerStream CreateNamedPipe(string endpoint)
    {
        // CurrentUserOnly mirrors RestrictSocketToOwner's 0600 hardening: the
        // pipe name is deterministic, so without it any local user could take
        // or connect to the single instance ahead of the host.
        return new NamedPipeServerStream(
            IpcConnection.PipeName(endpoint),
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly,
            PipeBufferSize,
            PipeBufferSize
        );
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Socket ownership transfers to IpcListener"
    )]
    private static Socket CreateUnixSocket(string effectivePath)
    {
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
}

/// <summary>
/// Creates platform IPC connections for sidecars.
/// </summary>
public static class IpcConnection
{
    private const string PipePrefix = @"\\.\pipe\";

    /// <summary>
    /// Generate a deterministic socket path from a workspace root.
    /// Format: /tmp/sharplsp-{hash8}.sock (stays under 108-char Unix limit),
    /// or \\.\pipe\sharplsp-{hash8} on Windows.
    /// </summary>
    public static string GenerateSocketPath(string workspaceRoot)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(workspaceRoot));
        var hex = Convert.ToHexString(hash).AsSpan(0, 8);
        return OperatingSystem.IsWindows()
            ? $@"{PipePrefix}sharplsp-{hex}"
            : Path.Combine(Path.GetTempPath(), $"sharplsp-{hex}.sock");
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
            // Preserve the exception type, not just its message: the type (e.g.
            // SocketException vs UnauthorizedAccessException) is what tells a
            // pipe-name squat apart from an ACL denial when diagnosing a
            // pre-READY exit. Implements [DIST-FAILURE-UX] (GitHub #150).
            return ListenerResult.Failure($"{ex.GetType().Name}: {ex.Message}");
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

    private static async Task<Stream> ConnectCoreAsync(string socketPath, CancellationToken ct)
    {
        return IsPipeEndpoint(socketPath)
            ? await ConnectNamedPipeAsync(socketPath, ct).ConfigureAwait(false)
            : await ConnectUnixSocketAsync(socketPath, ct).ConfigureAwait(false);
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Stream ownership transfers to caller via Result"
    )]
    private static async Task<Stream> ConnectNamedPipeAsync(string socketPath, CancellationToken ct)
    {
        var pipe = new NamedPipeClientStream(
            ".",
            PipeName(socketPath),
            PipeDirection.InOut,
            PipeOptions.Asynchronous
        );
        try
        {
            await pipe.ConnectAsync(ct).ConfigureAwait(false);
            return pipe;
        }
        catch
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Stream ownership transfers to caller via Result"
    )]
    private static async Task<Stream> ConnectUnixSocketAsync(
        string socketPath,
        CancellationToken ct
    )
    {
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

    /// <summary>True when the endpoint addresses the Windows named-pipe namespace.</summary>
    internal static bool IsPipeEndpoint(string endpoint)
    {
        return endpoint.StartsWith(PipePrefix, StringComparison.Ordinal);
    }

    internal static string PipeName(string endpoint)
    {
        return IsPipeEndpoint(endpoint)
            ? endpoint[PipePrefix.Length..]
            : throw new ArgumentException("Windows IPC endpoint must be a named pipe path");
    }
}
