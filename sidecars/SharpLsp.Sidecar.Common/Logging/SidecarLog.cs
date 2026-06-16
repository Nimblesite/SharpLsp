using System.Globalization;
using Serilog;

namespace SharpLsp.Sidecar.Common.Logging;

/// <summary>
/// Process-wide structured logging for sidecars (replaces raw
/// <c>Console.Error</c> diagnostics). Implements [DIST-CLEAN-OUTPUT].
///
/// The Rust host inherits the sidecar's stderr straight into the editor's
/// user-facing Output panel, so routine diagnostics written to stderr flood it
/// (issue #78). Instead, sidecars log to a per-sidecar rolling file under the
/// system temp directory; genuinely user-facing signals (e.g. a Roslyn version
/// mismatch) are surfaced separately and intentionally.
/// </summary>
public static class SidecarLog
{
    private const string OutputTemplate =
        "{Timestamp:yyyy-MM-ddTHH:mm:ss.fffZ} [{Level:u3}] {Message:lj}{NewLine}{Exception}";

    private static int _initialized;

    /// <summary>
    /// Configures the global <see cref="Log.Logger" /> exactly once. Subsequent
    /// calls are no-ops, so it is safe to call from both process startup and the
    /// host constructor.
    /// </summary>
    /// <param name="name">Identifies the sidecar (e.g. "csharp"); names the log file.</param>
    public static void Initialize(string name)
    {
        if (Interlocked.Exchange(ref _initialized, 1) == 1)
        {
            return;
        }

        var logDirectory = Path.Combine(Path.GetTempPath(), "sharplsp-logs");
        _ = Directory.CreateDirectory(logDirectory);

        Log.Logger = new LoggerConfiguration()
            .MinimumLevel.Debug()
            .WriteTo.File(
                Path.Combine(logDirectory, $"sidecar-{name}.log"),
                rollingInterval: RollingInterval.Day,
                shared: true,
                outputTemplate: OutputTemplate,
                formatProvider: CultureInfo.InvariantCulture
            )
            .CreateLogger();
    }

    /// <summary>Flushes and closes the global logger. Safe to call when uninitialized.</summary>
    public static void Shutdown()
    {
        Log.CloseAndFlush();
    }

    /// <summary>
    /// Collapses repeated identical lines in <paramref name="text" /> into a single
    /// line annotated with a repeat count, preserving first-seen order.
    ///
    /// A <c>ReflectionTypeLoadException</c> surfaced by MSBuild can carry dozens of
    /// identical "Could not load file or assembly" lines; this keeps the log to one
    /// line per distinct message instead of a flood.
    /// </summary>
    public static string CollapseRepeatedLines(string text)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');
            if (counts.TryAdd(line, 1))
            {
                order.Add(line);
            }
            else
            {
                counts[line]++;
            }
        }

        return string.Join('\n', order.Select(line => Annotate(line, counts[line])));
    }

    private static string Annotate(string line, int count)
    {
        return count > 1 ? $"{line} (repeated {count} times)" : line;
    }
}
