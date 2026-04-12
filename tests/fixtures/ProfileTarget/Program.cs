// Minimal .NET process for profiler E2E tests.
// Allocates objects so heap analysis has data, then sleeps until killed.

var objects = new List<string>(1000);
for (var i = 0; i < 1000; i++)
    objects.Add($"test-string-{i}");

Console.WriteLine("READY");
Console.Out.Flush();

// Keep running until killed.
Thread.Sleep(Timeout.Infinite);
