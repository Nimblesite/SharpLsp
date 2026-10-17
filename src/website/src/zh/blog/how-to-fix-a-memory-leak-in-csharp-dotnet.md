---
layout: layouts/blog.njk
title: "如何逐步修复 C# 和 .NET 中的内存泄漏"
description: "如何在 VS Code 中逐步查找并修复 C# 和 .NET 中的内存泄漏：用免费的 .NET 内存分析器检测内存泄漏，用保留图找出原因，修复它，以及事件、Dispose、计时器和依赖注入背后的 C# 内存泄漏。"
lang: zh
date: 2026-10-17
author: SharpLsp 团队
image: /assets/images/blog/how-to-fix-a-memory-leak-in-csharp-dotnet.png
imageAlt: 在 VS Code 中追踪 C# 内存泄漏，从不断攀升的堆时间线到持有每个 CustomerSession 的静态 Dictionary
tags:
  - posts
  - profiling
  - memory-leaks
  - csharp
  - fsharp
category: profiling
excerpt: "“fix memory leak”是人们搜索最多的内存问题，两年内翻了一倍多。这里是在 VS Code 中录制的一次完整的 C# 内存泄漏修复：发现攀升、排列可疑项、找到根、修复并验证。"
---

“fix memory leak”是人们搜索最多的内存问题，从 2024 年到 2026 年翻了一倍多。紧随其后的是“what is a memory leak”和“how to fix a memory leak”。大多数答案止步于“用内存分析器”。本文则把一个真实的 C# 内存泄漏处理到底：找到它，追溯到它的根，修复它并验证修复，全部在 VS Code 中用免费的 SharpLsp 内存分析器完成。

下面是在 VS Code 中录制的完整流程。快进的片段在画面上有标注：

{% video "profiler-fix-memory-leak" %}

## C# 中的内存泄漏是什么？

C# 有垃圾回收：.NET 运行时会释放所有不再被引用的对象。因此，C# 内存泄漏并不是忘记释放的内存，而是仍被某处持有的对象。静态列表、事件或长生命周期的服务保留着引用，垃圾回收器永远无法释放它，于是只要应用在运行，内存就会不断攀升。

## 泄漏

我们的 Storefront 演示应用在循环中不断结账。它的 `SessionCache` 把每个订单都“为了分析”记下来，放进一个从不删除任何内容的静态 `Dictionary`：

```csharp
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order) => Sessions[order.Id] = new CustomerSession(order);
}
```

每个 `CustomerSession` 都带有一个 4 KB 的缓冲区，而且没有任何东西会释放它。

## 第 1 步：发现攀升

打开 SharpLsp 视图。**Processes** 列出本机上每个 .NET 进程及其实时 CPU 和内存。Storefront 的内存只升不降。有升有降的内存是正常的垃圾回收；在稳定负载下只升不降的内存，就是可疑的泄漏。

## 第 2 步：跟踪内存

将鼠标悬停在 Storefront 那一行上，点击 **Track Memory**。内存仪表板在代码旁打开，开始拍摄堆快照，每个快照都与上一个比较。堆时间线随每个快照不断攀升。

## 第 3 步：查看可疑泄漏

在某个快照中增长的类型会成为可疑项。连续增长两次是 Medium，三次是 High。只需几个快照，`CustomerSession` 及其持有的一切，包括字节数组、订单和商品列表，都变成了 High，并且在每个快照中都持续增长。在编辑器中，`CustomerSession` 的声明处出现带有增长量的 `HIGH` 泄漏标记。点击可疑项，编辑器就会跳转到那里。

## 第 4 步：找出让它存活的引用

增长告诉你*什么*在泄漏，修复则需要知道*为什么*。运行 **SharpLsp: Show Reference Graph** 并选择 `Storefront.CustomerSession`。保留图会画出挂在同一个 `Dictionary<int, CustomerSession>` 条目数组上的每个 `CustomerSession`。代码中只有一个字段是这个类型：静态字段 `SessionCache.Sessions`。这就是要切断的引用。

## 第 5 步：修复

缓存只需要最近的订单，所以只保留最近 1,000 个，淘汰其余的：

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

在实际代码中，带大小限制或过期时间的 `MemoryCache` 也能完成同样的工作。

## 第 6 步：验证

重新构建、运行，然后再次跟踪内存。在录像中，有泄漏的版本在可疑项达到 High 之前就超过了 160 MB。修复后的版本稳定在 8 MB 左右，时间线平稳，也没有任何可疑项升到 Low 以上。没有测量过的修复只是猜测，而这次修复经过了测量。

## 用同样步骤还能找到的四种 C# 内存泄漏

步骤不变，变的只是保留图末端的根。

### 从未移除的事件处理程序

```csharp
public sealed class PriceTicker(MarketFeed feed) : IDisposable
{
    public void Start() => feed.PriceChanged += OnPriceChanged;

    public void Dispose() => feed.PriceChanged -= OnPriceChanged;

    private void OnPriceChanged(object? sender, decimal price) { }
}
```

长生命周期的 `MarketFeed` 通过它的事件持有每一个订阅者。没有 `-=`，每个 `PriceTicker` 都会和 feed 活得一样久。保留图的终点是 feed 的事件字段。

### 捕获了 scoped 服务的单例

在依赖注入中，单例在整个应用的生命周期内存活。如果它的构造函数接收一个 scoped 服务，例如 `DbContext`，那么这个实例连同它跟踪的一切都会被捕获，直到应用结束。保留图的终点是这个单例。改为注入 `IServiceScopeFactory`，并为每个工作单元创建一个作用域。

### 比所有者活得更久的计时器

`System.Threading.Timer` 运行期间，运行时的计时器队列会持有它的回调，而回调持有它的目标。一个计时器回调到自身的组件，会被自己的计时器一直保持存活。请在所有者销毁时一并释放计时器。

### F# 中的闭包

```fsharp
let handlers = ResizeArray<unit -> unit>()

let watch (session: CustomerSession) =
    handlers.Add(fun () -> printfn "%d" session.SnapshotBytes)
```

lambda 捕获了 `session`，而模块级列表保存着每一个 lambda。保留图的终点是 `handlers`。用完后移除委托，或者只捕获你需要的值。

## Dispose 能修复内存泄漏吗？

单靠它不能。`Dispose` 和 `using` 语句会在确定的时间释放非托管资源，但只要对象仍被某处引用，它们就不能让对象变得可回收。被静态列表持有的已释放对象仍然是泄漏。当 `Dispose` 是你取消事件订阅、停止计时器或清空缓存的地方时，它才能修复泄漏，就像上面的 `PriceTicker` 一样。

## 试一试

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) 安装 SharpLsp，或在 Cursor、Windsurf 和 VSCodium 中从 [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) 安装。[修复内存泄漏](/zh/docs/memory-leaks/)指南是这些步骤的参考版本，[性能分析器文档](/zh/docs/profiler/)介绍了所有命令和设置。想知道我们为什么写这篇文章，请阅读 [.NET 开发者在应用变慢或内存泄漏时会搜索什么](/zh/blog/dotnet-profiler-memory-leak-search-trends/)。
