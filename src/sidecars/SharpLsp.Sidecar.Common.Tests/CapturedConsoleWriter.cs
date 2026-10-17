using System.Text;

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Thread-safe console redirection target: the host writes READY/FATAL
/// lines from its own tasks while the test polls <see cref="Snapshot" />.
/// </summary>
internal sealed class CapturedConsoleWriter : TextWriter
{
    private readonly StringBuilder _buffer = new();
    private readonly Lock _gate = new();

    public override Encoding Encoding => Encoding.UTF8;

    public override void Write(char value)
    {
        lock (_gate)
        {
            _ = _buffer.Append(value);
        }
    }

    public override void Write(string? value)
    {
        lock (_gate)
        {
            _ = _buffer.Append(value);
        }
    }

    public string Snapshot()
    {
        lock (_gate)
        {
            return _buffer.ToString();
        }
    }
}
