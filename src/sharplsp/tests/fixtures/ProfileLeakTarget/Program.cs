// A deterministic profiling target. Prints "READY <pid>" once running, then
// burns CPU in Hot.Spin and grows LeakCache.Items until stdin closes.
namespace ProfileLeakTarget;

internal sealed class LeakedPayload
{
    public byte[] Data { get; } = new byte[1024];
    public string Label { get; init; } = "";
}

internal static class LeakCache
{
    public static readonly List<LeakedPayload> Items = [];

    public static void Grow(int count)
    {
        for (var i = 0; i < count; i++)
        {
            Items.Add(new LeakedPayload { Label = $"payload-{Items.Count}" });
        }
    }
}

internal static class Hot
{
    public static double Spin(int iterations)
    {
        var total = 0.0;
        for (var i = 0; i < iterations; i++)
        {
            total += Math.Sqrt(i) * Math.Sin(i);
        }
        return total;
    }
}

internal static class Program
{
    private static volatile bool _running = true;

    private static void Main()
    {
        var worker = new Thread(Work) { Name = "hot-worker", IsBackground = true };
        worker.Start();
        Console.WriteLine($"READY {Environment.ProcessId}");
        Console.Out.Flush();
        _ = Console.In.ReadToEnd();
        _running = false;
        worker.Join();
    }

    private static void Work()
    {
        var sink = 0.0;
        while (_running)
        {
            sink += Hot.Spin(200_000);
            LeakCache.Grow(50);
        }
        GC.KeepAlive(sink);
    }
}
