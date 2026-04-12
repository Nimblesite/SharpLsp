using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using SocketResult = Outcome.Result<System.Net.Sockets.Socket, string>;

namespace Forge.Sidecar.Common.Ipc;

/// <summary>
/// Creates Unix domain socket connections for sidecar IPC.
/// Named pipes on Windows, Unix domain sockets on macOS/Linux.
/// </summary>
public static class IpcConnection
{
    /// <summary>
    /// Generate a deterministic socket path from a workspace root.
    /// Format: /tmp/forge-{hash8}.sock (stays under 108-char Unix limit).
    /// </summary>
    public static string GenerateSocketPath(string workspaceRoot)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(workspaceRoot));
        var hex = Convert.ToHexString(hash).AsSpan(0, 8);
        return Path.Combine(Path.GetTempPath(), $"forge-{hex}.sock");
    }

    /// <summary>Start listening on a Unix domain socket.</summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Socket ownership transfers to caller via Result"
    )]
    public static SocketResult CreateListener(string socketPath)
    {
        try
        {
            return new SocketResult.Ok<Socket, string>(CreateListenerCore(socketPath));
        }
        catch (Exception ex)
        {
            return SocketResult.Failure(ex.Message);
        }
    }

    /// <summary>Connect to an existing Unix domain socket.</summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Socket ownership transfers to caller via Result"
    )]
    public static async Task<SocketResult> ConnectAsync(
        string socketPath,
        CancellationToken ct = default
    )
    {
        try
        {
            return new SocketResult.Ok<Socket, string>(
                await ConnectCoreAsync(socketPath, ct).ConfigureAwait(false)
            );
        }
        catch (Exception ex)
        {
            return SocketResult.Failure(ex.Message);
        }
    }

    private static Socket CreateListenerCore(string socketPath)
    {
        var effectivePath = ShortenIfNeeded(socketPath);

        if (File.Exists(effectivePath))
        {
            File.Delete(effectivePath);
        }

        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            socket.Bind(new UnixDomainSocketEndPoint(effectivePath));
            socket.Listen(1);
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private static async Task<Socket> ConnectCoreAsync(string socketPath, CancellationToken ct)
    {
        var effectivePath = ShortenIfNeeded(socketPath);
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            await socket
                .ConnectAsync(new UnixDomainSocketEndPoint(effectivePath), ct)
                .ConfigureAwait(false);
            return socket;
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
    private static string ShortenIfNeeded(string socketPath)
    {
        const int unixSocketPathLimit = 107;
        if (socketPath.Length <= unixSocketPathLimit)
        {
            return socketPath;
        }

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(socketPath));
        var hex = Convert.ToHexString(hash).AsSpan(0, 16);
        return Path.Combine(Path.GetTempPath(), $"forge-{hex}.sock");
    }
}
