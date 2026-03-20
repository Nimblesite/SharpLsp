using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

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
    public static Socket CreateListener(string socketPath)
    {
        if (File.Exists(socketPath))
        {
            File.Delete(socketPath);
        }

        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        socket.Bind(new UnixDomainSocketEndPoint(socketPath));
        socket.Listen(1);
        return socket;
    }

    /// <summary>Connect to an existing Unix domain socket.</summary>
    public static async Task<Socket> ConnectAsync(
        string socketPath,
        CancellationToken ct = default)
    {
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        await socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath), ct)
            .ConfigureAwait(false);
        return socket;
    }
}
