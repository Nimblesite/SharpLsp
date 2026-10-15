// Storefront: the demo workload the website's profiler film records.
// It checks out orders forever, with real hot paths and a cache that never evicts.
using Storefront;

var pipeline = new CheckoutPipeline(Catalog.Generate(itemCount: 2_000));
Console.WriteLine($"Storefront running (PID {Environment.ProcessId})");

for (var orderId = 0; ; orderId++)
{
    var order = pipeline.Checkout(orderId);
    SessionCache.Remember(order);
}
