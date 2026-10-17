---
layout: layouts/docs.njk
title: 修复 C# 和 .NET 中的内存泄漏
description: "如何查找并修复 C# 和 .NET 中的内存泄漏：什么是内存泄漏，如何在 VS Code 中用免费的 .NET 内存分析器检测内存泄漏，以及静态缓存、事件处理程序、Dispose 和依赖注入生命周期导致的泄漏该如何修复。"
lang: zh
eleventyExcludeFromCollections: true
---

# 修复 C# 和 .NET 中的内存泄漏

本指南介绍如何在 VS Code 中使用 SharpLsp 内存分析器，查找并修复 C# 或 F# 应用中的内存泄漏。你将跟踪进程、查看可疑泄漏、找到让对象一直存活的引用、修复它，并验证修复效果。它适用于任何正在运行的 .NET 8 或更高版本进程，无需重启，无需内存转储，也无需许可证。

{% video "profiler-fix-memory-leak" %}

## 什么是 .NET 中的内存泄漏？

.NET 有垃圾回收：运行时会释放所有不再被引用的对象。因此，.NET 中的内存泄漏并不是忘记释放的内存，而是仍被某处持有的对象，垃圾回收器永远无法释放它。在稳定负载下，进程内存持续攀升且从不回落，直到应用变得极其缓慢或内存耗尽。

本指南以 SharpLsp 的 Storefront 演示应用为例。它的 `SessionCache` 把每个订单都放进一个静态 `Dictionary`，并且从不删除：

```csharp
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order) => Sessions[order.Id] = new CustomerSession(order);
}
```

## 开始之前

- 安装 SharpLsp，并打开包含项目的文件夹。
- 在 .NET 8 或更高版本的运行时上运行应用。以 `DOTNET_EnableDiagnostics=0` 启动的进程无法附加。
- 让应用处于稳定负载下：反复执行你怀疑的请求、页面或任务。只有泄漏代码在运行时，泄漏才会显现。

## 1. 确认内存持续攀升

打开 SharpLsp 视图，在 **Processes** 中找到你的应用。每一行都显示进程实时的 CPU 和内存。在稳定负载下观察内存一分钟。内存有升有降，是垃圾回收在正常工作；内存只升不降，就是可疑的泄漏。

## 2. 跟踪内存

将鼠标悬停在该行上并点击 **Track Memory**，或运行 **SharpLsp: Start Memory Tracking**。**SharpLsp Memory Dashboard** 会在代码旁打开，显示当前内存与峰值内存、存活对象数和堆时间线。

开启定时堆快照，让仪表板替你完成内存泄漏检测：

```json
{
  "sharplsp.profiler.autoSnapshot": true,
  "sharplsp.profiler.autoSnapshotInterval": 10
}
```

你也可以用 **SharpLsp: Take Memory Snapshot** 手动拍摄快照，并用 **SharpLsp: Compare Memory Snapshots** 进行比较。在拍摄快照前运行 **SharpLsp: Force Garbage Collection**，可以排除只是尚未被回收的垃圾。

## 3. 查看可疑泄漏

每个快照都会与上一个快照比较。内存增长的类型会成为可疑泄漏，并且每连续增长一次，置信度就会提高：

| 证据 | 置信度 |
|---|---|
| 增长一次 | Low |
| 连续增长两次，或单次增长超过 10 MiB | Medium |
| 连续增长三次 | High |

只要某个快照中该类型没有增长，它的连续计数就会清零，因此正常的分配波动很少会达到 High。每个可疑项都会显示以字节和对象数计的增长。点击可疑项即可打开其分配位置。在编辑器中，泄漏类型的声明处会出现紫色热力条和泄漏标记。当第一个可疑项达到 High 时，SharpLsp 会在通知中提供 **Show Reference Graph**。

## 4. 找出让它存活的引用

运行 **SharpLsp: Show Reference Graph** 并选择可疑项的类型。列表中提供的是运行时在最新快照中报告的类型。选择 **Other type…** 可以按运行时的精确拼写输入类型名，例如 `Storefront.CustomerSession`。

保留图会画出持有该类型的对象，以及让它们存活的根。请从根开始往下读，再到代码中找出持有这个根的字段。在 Storefront 中，每个 `CustomerSession` 都挂在同一个 `Dictionary<int, CustomerSession>` 的条目数组上，而这个类型的字段只有一个：静态字段 `SessionCache.Sessions`。

堆增长只是信号，不是证据。请结合保留路径和代码的设计意图来确认可疑项：本来就该保存所有内容的缓存不是泄漏。

## 5. 修复内存泄漏

保留路径指明了要切断的引用。以下是 C# 内存泄漏的常见原因：

| 路径终点 | 修复方法 |
|---|---|
| 静态集合或缓存 | 给它设上限：淘汰旧条目、限制大小，或使用带过期时间的 `MemoryCache` |
| 长生命周期对象上的事件 | 订阅者用完后用 `-=` 取消订阅，例如在它的 `Dispose` 中 |
| 单例服务 | 检查依赖注入的生命周期：捕获了 scoped 或 transient 服务的单例，会让它在整个应用生命周期内存活 |
| 计时器或运行中的任务 | 在所有者销毁时释放计时器并取消任务 |
| 存放在长生命周期对象上的 lambda | 闭包捕获了该对象：少捕获一些，或用完后移除委托 |

Storefront 的修复只保留最近 1,000 个订单，淘汰其余的：

```csharp
public static void Remember(Order order)
{
    Sessions[order.Id] = new CustomerSession(order);
    Sessions.Remove(order.Id - 1_000);
}
```

同样的泄漏在 F# 中是一个模块级的 `Dictionary`，修复方法也一样：

```fsharp
let private sessions = Dictionary<int, CustomerSession>()

let remember (order: Order) =
    sessions[order.Id] <- CustomerSession order
    sessions.Remove(order.Id - 1_000) |> ignore
```

## 6. 验证修复

重新构建，在相同负载下运行应用，然后再次跟踪内存。缓存填满后，堆时间线应该趋于平稳，也不应有任何可疑项升到 High。如果仍有可疑项升到 High，再次查看它的保留图：还有第二个根在持有它。

## 常见问题

### Dispose 能修复内存泄漏吗？

只有当泄漏的正是 `Dispose` 释放的东西时才能。`Dispose` 和 `using` 语句会在确定的时间释放非托管资源，例如句柄、套接字和本机内存。只要对象仍被某处引用，它们就不能让对象变得可回收。被静态列表持有的已释放对象，仍然是泄漏。当 `Dispose` 是你取消事件订阅或停止计时器的地方时，它才有帮助。

### 我需要堆转储或内存转储吗？

不需要。`dotnet-dump` 和 `dotnet-gcdump` 会写出一个文件，你还得在 Visual Studio 或 PerfView 等其他工具中打开。SharpLsp 通过运行时的诊断通道从正在运行的进程读取堆快照，因此内存分析器可以在 Windows、macOS 和 Linux 上直接在编辑器中工作。当你需要保留证据，或进程运行在无法附加的机器上时，再使用转储。

### 这是 Visual Studio 的内存分析器吗？

不是。这是 SharpLsp 自己的内存分析器，开源并采用 MIT 许可证。它在 VS Code、Cursor、Windsurf 和 VSCodium 中提供相同的流程：快照、比较和保留路径。

## 相关内容

- [性能分析器](/zh/docs/profiler/)：所有性能分析器命令和设置
- [配置](/zh/docs/configuration/)：`sharplsp.toml` 中的 `[profiler]` 表
- [如何逐步修复 C# 和 .NET 中的内存泄漏](/zh/blog/how-to-fix-a-memory-leak-in-csharp-dotnet/)：一个泄漏，从最初的怀疑到经过测量的修复
