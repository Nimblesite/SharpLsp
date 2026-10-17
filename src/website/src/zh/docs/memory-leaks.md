---
layout: layouts/docs.njk
title: 如何修复 C# 和 .NET 中的内存泄漏
description: "逐步讲解如何修复 C# 和 .NET 中的内存泄漏：在 VS Code 中用免费的 .NET 内存分析器检测内存泄漏，用保留路径找出原因，修复静态缓存、事件处理程序、Dispose、计时器和依赖注入引起的泄漏，以及使用 dotnet-counters、dotnet-gcdump 和 dotnet-dump 的方法。"
lang: zh
eleventyExcludeFromCollections: true
---

# 如何修复 C# 和 .NET 中的内存泄漏

本指南带你处理一个真实的 C# 内存泄漏，从最初的怀疑一直到经过测量的修复。你将确认内存持续攀升，在 VS Code 中用免费的 SharpLsp 内存分析器跟踪进程，查看可疑泄漏，找到让对象一直存活的引用并修复它，再用测试证明修复有效。它适用于任何运行在 .NET 8 或更高版本上的 C# 或 F# 应用，无需重启，无需内存转储，也无需许可证。如果某个步骤有命令行或 Visual Studio 的对应做法，本指南也会一并介绍。

下面是在 VS Code 中录制的 SharpLsp Storefront 演示的完整流程。快进的片段在画面上有标注：

{% video "profiler-fix-memory-leak" %}

## 什么是 C# 和 .NET 中的内存泄漏？

.NET 有[垃圾回收](https://learn.microsoft.com/zh-cn/dotnet/standard/garbage-collection/fundamentals)：运行时会释放所有不再被引用的对象。因此，C# 内存泄漏并不是忘记释放的内存，而是应用已经不再需要、却仍被某处引用的对象，例如被静态集合、事件、长生命周期的服务或计时器引用。正如 Microsoft 的[内存泄漏教程](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/debug-memory-leak)所说，这样的引用会让垃圾回收器无法回收所用的内存。在稳定负载下，只要泄漏代码还在运行，进程内存就会持续攀升。

Storefront 正好有这个 bug。它的 `SessionCache` 把每个订单都“为了分析”记录在一个静态 `Dictionary` 中，并且从不删除：

```csharp
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order) => Sessions[order.Id] = new CustomerSession(order);
}
```

每个 `CustomerSession` 都带着一个 4 KB 的缓冲区，而且没有一个会被释放。

## 内存泄漏的迹象

- 在稳定负载下内存持续攀升，从不回落。
- 应用运行几小时或几天后越来越慢，重启后能暂时恢复。
- 垃圾回收越来越频繁，每次回收的内存却越来越少。
- 应用抛出 `OutOfMemoryException`，或者容器因超出内存限制而被终止。

### 是内存泄漏，还是只是内存占用高？

并非所有攀升都是泄漏。[服务器垃圾回收](https://learn.microsoft.com/zh-cn/dotnet/standard/garbage-collection/workstation-server-gc)按设计会比工作站垃圾回收保留更大的堆。本来就要保存所有内容的缓存会先填满，然后趋于平稳。此外，垃圾回收器不会立即把释放的内存归还给操作系统。

要区分它们，请运行 **SharpLsp: Force Garbage Collection**，它会执行一次完整的阻塞式回收。如果内存回落，那只是尚未被回收的垃圾。如果在相同负载下内存居高不下并继续攀升，就说明有东西在持有它。

### 托管还是本机？

**Processes** 视图显示每个进程的常驻内存，也就是操作系统分配给它的全部内存。内存仪表板显示托管堆，也就是垃圾回收器跟踪的对象。如果常驻内存在攀升而堆保持平稳，泄漏就在本机内存中，例如本机库、从未释放的 `Marshal.AllocHGlobal` 缓冲区，或所有者从未被释放的[非托管资源](https://learn.microsoft.com/zh-cn/dotnet/standard/garbage-collection/unmanaged)。堆快照看不到本机内存。在 Windows 上，Visual Studio 的[内存使用率工具](https://learn.microsoft.com/zh-cn/visualstudio/profiling/memory-usage)可以拍摄本机堆的快照。本指南接下来的内容将查找并修复托管泄漏。

## 开始之前

- 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) 安装 SharpLsp，或在 Cursor、Windsurf 和 VSCodium 中从 [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) 安装，然后打开包含项目的文件夹。
- 在 .NET 8 或更高版本的运行时上运行应用。以 [`DOTNET_EnableDiagnostics=0`](https://learn.microsoft.com/zh-cn/dotnet/core/runtime-config/debugging-profiling) 启动的进程无法附加。
- 让应用处于稳定负载下：反复执行你怀疑的请求、页面或任务。只有泄漏代码在运行时，泄漏才会显现。

## 第 1 步：确认内存持续攀升

打开 SharpLsp 视图，在 **Processes** 中找到你的应用。每一行都显示进程实时的 CPU 和内存。在稳定负载下观察内存一分钟。内存有升有降，是垃圾回收在正常工作；内存只升不降，就是可疑的泄漏。Storefront 的内存只升不降。

在终端中，[dotnet-counters](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/dotnet-counters) 也能显示同样的攀升。运行 `dotnet-counters monitor --refresh-interval 1 -p <pid>`，观察 GC 堆大小（在 .NET 9 及更高版本中为 `dotnet.gc.last_collection.heap.size`）。

## 第 2 步：跟踪内存

将鼠标悬停在该行上并点击 **Track Memory**，或运行 **SharpLsp: Start Memory Tracking**。**SharpLsp Memory Dashboard** 会在代码旁打开，显示当前内存与峰值内存、存活对象数和堆时间线。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-memory.webp" alt="内存仪表板显示持续攀升的堆时间线，并标注 STEADY GROWTH possible leak，旁边是 SessionCache.cs" width="2400" height="1500">
  <figcaption>每次快照后时间线都在上升，图表会标出持续增长。</figcaption>
</figure>

开启定时堆快照，让仪表板替你完成内存泄漏检测：

```json
{
  "sharplsp.profiler.autoSnapshot": true,
  "sharplsp.profiler.autoSnapshotInterval": 10
}
```

你也可以用 **SharpLsp: Take Memory Snapshot** 手动拍摄快照，并用 **SharpLsp: Compare Memory Snapshots** 进行比较。每个快照都从一次完整的垃圾回收开始，因此只统计在回收后存活下来的对象。

## 第 3 步：查看可疑泄漏

每个快照都会与上一个快照比较。内存增长的类型会成为可疑泄漏，并且每连续增长一次，置信度就会提高：

| 证据 | 置信度 |
|---|---|
| 增长一次 | Low |
| 连续增长两次，或单次增长超过 10 MiB | Medium |
| 连续增长三次 | High |

只要某个快照中该类型没有增长，它的连续计数就会清零，因此正常的分配波动很少会达到 High。每个可疑项都会显示以字节和对象数计的增长。点击可疑项即可打开其分配位置。在编辑器中，泄漏类型的声明处会出现紫色热力条和泄漏标记。当第一个可疑项达到 High 时，SharpLsp 会在通知中提供 **Show Reference Graph**。

几个快照之后，Storefront 的 `CustomerSession` 就会达到 High，它持有的字节数组、订单和商品列表也一样。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-leaks.webp" alt="标为 HIGH 的可疑泄漏，显示以 MB 计的增长和对象数，SessionCache.cs 中 CustomerSession 声明处有内联 HIGH 泄漏标记" width="2400" height="1500">
  <figcaption>可疑泄漏。从不淘汰条目的静态 <code>Dictionary</code> 表现为字节数组、字符串以及持有它们的会话对象的持续增长。</figcaption>
</figure>

## 第 4 步：找出让它存活的引用

增长告诉你泄漏的*是什么*，而修复需要知道*为什么*。运行 **SharpLsp: Show Reference Graph** 并选择可疑项的类型。列表中提供的是运行时在最新快照中报告的类型。选择 **Other type…** 可以按运行时的精确拼写输入类型名，例如 `Storefront.CustomerSession`。

保留图会画出持有该类型的对象，以及让它们存活的根。请从根开始往下读，再到代码中找出持有这个根的字段。在 Storefront 中，每个 `CustomerSession` 都挂在同一个 `Dictionary<int, CustomerSession>` 的条目数组上，而这个类型的字段只有一个：静态字段 `SessionCache.Sessions`。这就是要切断的引用。

在内存转储中，回答这个问题的是 `gcroot`；在 Visual Studio 中，是 **Paths to Root**。堆增长只是信号，不是证据。请结合保留路径和代码的设计意图来确认可疑项：本来就该保存所有内容的缓存不是泄漏。

## 第 5 步：修复内存泄漏

Storefront 的缓存只需要最近的订单，所以只保留最近 1,000 个订单，淘汰其余的：

```csharp
// Remembers the last 1,000 orders "for analytics", and forgets older ones.
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order)
    {
        Sessions[order.Id] = new CustomerSession(order);
        Sessions.Remove(order.Id - 1_000);
    }
}
```

同样的泄漏在 F# 中是一个模块级的 `Dictionary`，修复方法也一样：

```fsharp
let private sessions = Dictionary<int, CustomerSession>()

let remember (order: Order) =
    sessions[order.Id] <- CustomerSession order
    sessions.Remove(order.Id - 1_000) |> ignore
```

在实际代码中，带大小限制或过期时间的 `MemoryCache` 也能做到同样的事。如果你的保留路径终点在别处，请在下文的“*常见的 C# 内存泄漏*”中查找修复方法。

## 第 6 步：证明修复有效

重新构建，在相同负载下运行应用，然后再次跟踪内存。缓存填满后，堆时间线应该趋于平稳，也不应有任何可疑项升到 High。如果仍有可疑项升到 High，再次查看它的保留图：还有第二个根在持有它。

在录像中，存在泄漏的构建在可疑项达到 High 之前就超过了 160 MB。修复后的构建稳定在约 8 MB，时间线平稳，没有任何可疑项超过 Low。没有测量过的修复只是猜测，而这个修复经过了测量。要让它保持修复状态，请按下文所示添加泄漏测试。

## 常见的 C# 内存泄漏及修复方法

不管是哪种泄漏，步骤都一样，变的只是保留路径终点的那个根：

| 路径终点 | 修复方法 |
|---|---|
| 静态集合或缓存 | 给它设上限：淘汰旧条目、限制大小，或使用带过期时间的 `MemoryCache` |
| 长生命周期对象上的事件 | 订阅者用完后用 `-=` 取消订阅，例如在它的 `Dispose` 中 |
| 单例服务 | 检查依赖注入的生命周期：捕获了 scoped 服务的单例，会在整个应用生命周期内持有它 |
| 计时器 | 在所有者销毁时释放计时器 |
| 取消令牌 | 工作结束时释放 `CancellationTokenRegistration` |
| 存放在长生命周期对象上的 lambda | 闭包捕获了该对象：少捕获一些，或用完后移除委托 |

### 从不淘汰条目的静态集合或缓存

Storefront 的泄漏就属于这一类。静态字段与应用同生共死，其中的一切也是如此。F# 中的模块级值也一样。请给集合设上限，或使用设置了过期时间或 `SizeLimit` 的 [`MemoryCache`](https://learn.microsoft.com/zh-cn/dotnet/core/extensions/caching)。设置了 `SizeLimit` 时，每个条目都必须设置自己的 `Size`。

### 从未移除的事件处理程序

```csharp
public sealed class PriceTicker(MarketFeed feed) : IDisposable
{
    public void Start() => feed.PriceChanged += OnPriceChanged;

    public void Dispose() => feed.PriceChanged -= OnPriceChanged;

    private void OnPriceChanged(object? sender, decimal price) { }
}
```

长生命周期的 `MarketFeed` 通过它的事件持有每个订阅者。没有 `-=`，每个 `PriceTicker` 都会和行情源活得一样久。保留路径终止于行情源的事件字段。

在 F# 中，`Add` 的订阅无法取消。`Subscribe` 会返回一个用来移除处理程序的 `IDisposable`，请保存它，并随订阅者一起释放：

```fsharp
type PriceTicker(feed: MarketFeed) =
    let mutable last = 0M
    let subscription = feed.PriceChanged.Subscribe(fun price -> last <- price)

    member _.Last = last

    interface IDisposable with
        member _.Dispose() = subscription.Dispose()
```

在 WPF 中，控件并不总能判断何时取消订阅，这时请使用[弱事件模式](https://learn.microsoft.com/zh-cn/dotnet/desktop/wpf/events/weak-event-patterns)。

### 捕获了 scoped 服务的单例

在依赖注入中，单例会存活于整个应用生命周期。如果单例接收了 `DbContext` 这样的 scoped 服务，这一个实例连同它跟踪的所有实体，都会被捕获到应用结束：

```csharp
builder.Services.AddDbContext<ShopContext>();
builder.Services.AddSingleton<PriceCache>();

// Leaks: one ShopContext, and everything it tracks, lives as long as the app.
public sealed class PriceCache(ShopContext db) { }
```

Microsoft 的[依赖注入准则](https://learn.microsoft.com/zh-cn/dotnet/core/extensions/dependency-injection/guidelines)把这种情况称为“捕获的依赖项”。开启作用域验证后，容器在解析该单例时会拒绝它。ASP.NET Core 在 Development 环境中会开启作用域验证。修复方法是接收 `IServiceScopeFactory`，并为每个工作单元创建一个作用域：

```csharp
public sealed class PriceCache(IServiceScopeFactory scopes)
{
    public async Task<decimal> PriceOfAsync(int productId)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ShopContext>();
        return await db.Products.Where(p => p.Id == productId).Select(p => p.Price).SingleAsync();
    }
}
```

同一份准则还提醒了可释放的 transient 服务：容器会把每个这样的服务保留到其作用域结束，所以从根提供程序解析的服务会一直保留到应用停止。

### 比所有者活得更久的计时器

```csharp
public sealed class StockPoller : IDisposable
{
    private readonly Timer timer;

    public StockPoller() => timer = new Timer(_ => Poll(), null, TimeSpan.Zero, TimeSpan.FromSeconds(5));

    public void Dispose() => timer.Dispose();

    private void Poll() { }
}
```

这个轮询类按照 [`Timer` 文档](https://learn.microsoft.com/zh-cn/dotnet/api/system.threading.timer)的要求把计时器保存在字段中，而计时器的回调又指回轮询类本身。只要计时器在运行，运行时的计时器队列就会持有这个回调，因此轮询类永远无法被回收。请随所有者一起释放计时器。

### 注册在长生命周期令牌上的回调

```csharp
// Each call adds a callback to the app's stopping token, and only shutdown removes it.
lifetime.ApplicationStopping.Register(() => session.Close());

// Fixed: the registration is removed when the work ends.
using var registration = lifetime.ApplicationStopping.Register(() => session.Close());
```

[`CancellationToken.Register`](https://learn.microsoft.com/zh-cn/dotnet/api/system.threading.cancellationtoken.register) 会返回一个 `CancellationTokenRegistration`。在你释放它或令牌被取消之前，令牌的源会一直持有该回调及其捕获的一切。

### F# 中的闭包

```fsharp
let handlers = ResizeArray<unit -> unit>()

let watch (session: CustomerSession) =
    handlers.Add(fun () -> printfn "%d" session.SnapshotBytes)
```

lambda 捕获了 `session`，而模块级的列表保存了每个 lambda。保留路径终止于 `handlers`。用完后请移除委托，或只捕获你需要的值。

## 用测试守住泄漏修复

泄漏测试会让被测代码丢掉它应当丢掉的所有引用，执行回收，然后断言对象已经消失。请在一个不会被内联的单独方法中创建对象，这样测试中的局部变量就不会让它一直存活。`GC.KeepAlive(feed)` 让长生命周期的发布者一直存活到最后，所以只要行情订阅者仍在订阅，测试就会失败：

```csharp
[Fact]
public void ADisposedTickerCanBeCollected()
{
    var feed = new MarketFeed();
    var ticker = StartAndDispose(feed);

    GC.Collect();
    GC.WaitForPendingFinalizers();
    GC.Collect();

    Assert.False(ticker.IsAlive);
    GC.KeepAlive(feed);
}

[MethodImpl(MethodImplOptions.NoInlining)]
private static WeakReference StartAndDispose(MarketFeed feed)
{
    using var ticker = new PriceTicker(feed);
    ticker.Start();
    return new WeakReference(ticker);
}
```

用 F# 写的同一个测试：

```fsharp
[<MethodImpl(MethodImplOptions.NoInlining)>]
let startAndDispose (feed: MarketFeed) =
    use ticker = new PriceTicker(feed)
    WeakReference ticker

[<Fact>]
let ``a disposed ticker can be collected`` () =
    let feed = MarketFeed()
    let ticker = startAndDispose feed
    GC.Collect()
    GC.WaitForPendingFinalizers()
    GC.Collect()
    Assert.False ticker.IsAlive
    GC.KeepAlive feed
```

把取消订阅从 `Dispose` 中去掉，测试就会失败：行情源的事件仍然持有该订阅者。[`WeakReference`](https://learn.microsoft.com/zh-cn/dotnet/api/system.weakreference) 可以观察一个对象，而不会让它一直存活。

## 在命令行中检测内存泄漏

在服务器或容器中，.NET 诊断工具无需编辑器也能找到同样的泄漏。Microsoft 的[调试内存泄漏](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/debug-memory-leak)教程逐步介绍了这些工具。

用 `dotnet-counters` 确认攀升：

```console
dotnet tool install --global dotnet-counters
dotnet-counters ps
dotnet-counters monitor --refresh-interval 1 -p <pid>
```

用 [dotnet-gcdump](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/dotnet-gcdump) 拍摄堆快照。`report` 会按大小列出堆中的类型。相隔几分钟收集两个 GC 转储，然后在 Windows 上用 Visual Studio 或 [PerfView](https://github.com/microsoft/perfview) 比较它们。收集时会触发一次完整的垃圾回收，堆很大的应用可能因此暂停很长时间。

```console
dotnet-gcdump collect -p <pid>
dotnet-gcdump report <file>.gcdump
```

用 [dotnet-dump](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/dotnet-dump) 及其 [SOS 命令](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/sos-debugging-extension)找到根。`dumpheap -stat` 按数量和大小列出类型，`dumpheap -mt` 列出某个类型的实例，`gcroot` 打印从根到某个实例的引用链。转储包含进程的全部内存，包括其中的机密信息，请像对待生产数据一样处理它。

```console
dotnet-dump collect -p <pid>
dotnet-dump analyze <dump-file>
> dumpheap -stat
> dumpheap -mt <method-table>
> gcroot <object-address>
```

在生产环境中，[dotnet-monitor](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/dotnet-monitor) 可以通过 HTTP API 收集同样的转储和 GC 转储。

| 工具 | 运行环境 | 用途 |
|---|---|---|
| SharpLsp 内存分析器 | Windows、macOS 和 Linux 上的 VS Code、Cursor、Windsurf 和 VSCodium | 实时为可疑泄漏排名，并在代码旁画出保留路径 |
| `dotnet-counters` | 任意终端 | 确认堆在持续攀升 |
| `dotnet-gcdump` | 任意终端；在 Windows 上打开文件 | 为运行中的堆拍摄快照并比较 |
| `dotnet-dump` | 任意终端 | 保留完整转储，并用 `gcroot` 找到根 |
| `dotnet-monitor` | 服务器和容器 | 在生产环境中收集转储 |
| Visual Studio 内存使用率工具 | Windows | 在调试时拍摄快照、比较并沿 Paths to Root 追踪 |
| PerfView | Windows | 深入分析堆和垃圾回收 |

## 常见问题

### Dispose 能修复内存泄漏吗？

单靠它不能。`Dispose` 和 `using` 语句会在确定的时间释放非托管资源，例如句柄、套接字和本机内存。只要对象仍被某处引用，它们就不能让对象变得可回收。被静态列表持有的已释放对象，仍然是泄漏。只有当 `Dispose` 正是你取消事件订阅、停止计时器或清空缓存的地方时，它才能修复泄漏，就像上面的 `PriceTicker`。Microsoft 的[实现 Dispose 方法](https://learn.microsoft.com/zh-cn/dotnet/standard/garbage-collection/implementing-dispose)介绍了这一模式。

### GC.Collect 能修复内存泄漏吗？

不能。回收只会释放不再被任何东西引用的对象，而泄漏的对象仍被引用。强制回收在诊断和测试时有用，可以排除只是尚未被回收的垃圾。它永远修复不了泄漏。

### 我需要堆转储或内存转储吗？

不需要。`dotnet-dump` 和 `dotnet-gcdump` 会写出一个文件，你还得在 Visual Studio 或 PerfView 等其他工具中打开。SharpLsp 通过运行时的[诊断通道](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/eventpipe)从正在运行的进程读取堆快照，因此内存分析器可以在 Windows、macOS 和 Linux 上直接在编辑器中工作。当你需要保留证据，或进程运行在无法附加的机器上时，再使用转储。

### 这是 Visual Studio 的内存分析器吗？

不是。这是 SharpLsp 自己的内存分析器，开源并采用 MIT 许可证。Visual Studio 的内存使用率工具在 Windows 上提供相同的流程：快照、比较和 Paths to Root，还能提示事件处理程序泄漏。SharpLsp 把这一流程带到了各个平台上的 VS Code、Cursor、Windsurf 和 VSCodium。

## 延伸阅读

- [调试内存泄漏](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/debug-memory-leak)：Microsoft 关于 `dotnet-counters` 和 `dotnet-dump` 的教程
- [垃圾回收的基础](https://learn.microsoft.com/zh-cn/dotnet/standard/garbage-collection/fundamentals)：.NET 垃圾回收器如何判断哪些对象仍然存活
- [mem-doc](https://github.com/Maoni0/mem-doc)：.NET GC 架构师 Maoni Stephens 编写的 .NET 内存分析指南；Maoni Stephens 也在 [.NET Blog](https://devblogs.microsoft.com/dotnet/author/maoni/) 上撰写 GC 相关文章
- [Pro .NET Memory Management](https://prodotnetmemory.com/)：Konrad Kokosa、Kevin Gosse 和 Christophe Nasarre 合著的 .NET 内存内部原理专著
- [依赖注入准则](https://learn.microsoft.com/zh-cn/dotnet/core/extensions/dependency-injection/guidelines)：捕获的依赖项与可释放的 transient 服务
- [测量应用中的内存使用率](https://learn.microsoft.com/zh-cn/visualstudio/profiling/memory-usage)：Visual Studio 的内存使用率工具
- [8 Ways You can Cause Memory Leaks in .NET](https://michaelscodingspot.com/ways-to-cause-memory-leaks-in-dotnet/)：Michael Shpilt 整理的常见泄漏原因

## 相关内容

- [性能分析器](/zh/docs/profiler/)：所有性能分析器命令和设置
- [配置](/zh/docs/configuration/)：`sharplsp.toml` 中的 `[profiler]` 表
