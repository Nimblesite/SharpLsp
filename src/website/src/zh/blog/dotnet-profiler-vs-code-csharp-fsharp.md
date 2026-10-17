---
layout: layouts/blog.njk
title: "VS Code 中的免费 .NET 性能分析器：C# 与 F# 的 CPU、内存和泄漏分析"
description: "SharpLsp 的性能分析器可以在 VS Code、Cursor、Windsurf 或 VSCodium 中附加到任意正在运行的 .NET 进程。热点代码行直接在代码中高亮，火焰图在旁边打开，实时堆时间线为可疑的内存泄漏排序。MIT 许可，支持 C# 与 F#。"
lang: zh
date: 2026-10-17
author: SharpLsp 团队
image: /assets/images/blog/dotnet-profiler-vs-code-csharp-fsharp.png
imageAlt: VS Code 中 C# 代码上的 SharpLsp 性能分析热度条，旁边是一条持续攀升并被标记为可能泄漏的内存时间线
tags:
  - posts
  - profiling
  - memory-leaks
  - csharp
  - fsharp
category: profiling
excerpt: "应用变慢了，或者内存一直在涨。SharpLsp 现在可以在不离开 VS Code 的情况下分析任意正在运行的 .NET 进程的 CPU 和内存，并把答案标在导致问题的那一行代码上。"
---

每个 .NET 应用迟早都会变慢，或者开始占着本该释放的内存不放。要找出原因，过去通常意味着离开 VS Code：在 Windows 上打开 Visual Studio 的性能分析器，购买 dotTrace 和 dotMemory，或者在命令行中录制跟踪，再用另一个工具去读。

SharpLsp 的性能分析器就在你写代码的地方完成这件事。它可以分析任意正在运行的 .NET 进程的 CPU 和内存，并把热点代码行和可疑泄漏直接标在源代码上。它采用 MIT 许可，无需账户。一分钟了解它：

{% video "profiler-film" %}

## 从症状开始

没有人一早醒来就想用性能分析器。起点总是停不下来的风扇、一个要花四秒的请求、一条 CPU 使用率过高的告警，或者一个每晚都因内存耗尽而被杀掉的容器。这时你还不知道是哪个进程出了问题，更不用说是哪一行。

所以性能分析器也从这里开始。SharpLsp 侧边栏中的 **Processes** 视图列出本机上的每个 .NET 进程，显示其 PID、运行时、实时 CPU 和内存。那个占满一个核心或者无限增长的进程，在你分析任何东西之前就已经很显眼。属于当前工作区的进程会高亮显示。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-processes.webp" alt="SharpLsp 侧边栏中的进程视图，列出正在运行的 Storefront .NET 进程及其 Profile CPU 和 Track Memory 操作" width="2400" height="1500">
  <figcaption>进程视图：每个 .NET 进程的 PID、运行时、CPU 和内存。</figcaption>
</figure>

将鼠标悬停在某一行上，点击 **Profile CPU** 或 **Track Memory**。如果问题在启动时就出现，**Run & Profile CPU (Current File)** 会在 SharpLsp 调试器下启动项目，并从启动时开始分析。

## CPU 分析：不只是热点方法，而是热点代码行

这段录屏未经剪辑，以实时速度播放：

{% video "profiler-cpu-recording" %}

采样器通过 [EventPipe](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/eventpipe) 附加到进程，这是运行时自带的诊断通道。默认采样频率为 100 Hz。它可以作用于已经在运行的进程，因此无需重启应用、重新构建或添加任何包。低开销采样也是其他生态系统中性能分析器的工作方式，例如 Python 的 py-spy 和 Java 的 async-profiler。.NET 开发者也应该在编辑器里拥有同样的工具。

停止会话后，结果就出现在你的代码中。每个热点代码行都会显示一个内联热度条，标出它所占的采样比例；概览标尺也会标记每一行，方便你直接跳转：

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-heatmap.webp" alt="带有内联热度条的 CheckoutPipeline.cs：ParseCatalog 66.8%，PriceBasket 25.1%，RenderInvoice 7.6%" width="2400" height="1500">
  <figcaption>JSON 解析占用了三分之二的时间，并精确定位到具体代码行。</figcaption>
</figure>

方法级的性能分析器会告诉你 `Checkout` 很慢。热度条则告诉你，问题出在第 17 行的 `JsonSerializer.Deserialize` 调用，而下一个要看的是购物篮的计价。

结果面板在代码旁边打开。它显示采样数和时长、一张[火焰图](https://www.brendangregg.com/flamegraphs.html)，以及一张包含总占比和自身占比的热点函数表。在火焰图中，每个方框是一个函数，宽度代表它所占的时间比例。高调用栈底部最宽的方框通常就是该看的地方。点击某一帧即可放大：

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-flamegraph-zoom.webp" alt="放大到 ParseCatalog 的火焰图，显示 System.Text.Json 反序列化调用栈" width="2400" height="345">
  <figcaption>放大到 <code>ParseCatalog</code>：开销来自 System.Text.Json 反序列化器。</figcaption>
</figure>

<kbd>Ctrl+Alt+P</kbd>（macOS 上为 <kbd>Cmd+Alt+P</kbd>）可以在任何地方开始一次会话，**Take Profile Snapshot** 可以在不停止的情况下查看目前为止的结果。

## 内存分析与泄漏检测

大多数 .NET 内存泄漏并不是 C 语言意义上的泄漏。[垃圾回收器](https://learn.microsoft.com/zh-cn/dotnet/standard/garbage-collection/fundamentals)会释放任何不再被引用的对象。托管泄漏是指仍然被某个东西持有的对象：

- 从不淘汰的静态缓存；
- 从未移除的事件处理程序；
- 捕获了作用域服务的单例，Microsoft 称之为[捕获依赖项](https://learn.microsoft.com/zh-cn/dotnet/core/extensions/dependency-injection/guidelines)；
- 闭包让其所有者一直存活的计时器或 `CancellationToken.Register` 回调。

单靠 `Dispose` 修不好这些问题。[Dispose](https://learn.microsoft.com/zh-cn/dotnet/standard/garbage-collection/implementing-dispose) 释放的是非托管资源，但仍被引用的对象无论是否已释放，都会留在堆上。要找到泄漏，就要观察什么在增长，并追问是什么让它一直存活。

这正是 **Track Memory** 所做的事。内存仪表板在代码旁边打开，并在应用运行时为堆拍摄快照：

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-memory.webp" alt="内存仪表板中稳步攀升的堆时间线被标记为 STEADY GROWTH possible leak，旁边是 SessionCache.cs" width="2400" height="1500">
  <figcaption>堆时间线随每次快照攀升，仪表板会指出这种稳定增长。</figcaption>
</figure>

仪表板显示当前和峰值内存、存活对象数、堆时间线、主要分配位置以及排序后的可疑泄漏。你不必记着去拍快照。每当调试器暂停时，分析器都会拍一张快照并与上一张比较，也可以按定时器拍摄。

可疑项按照它们在多次快照之间增长的一致程度排序，并显示字节数和对象数的增长量。在编辑器中，泄漏类型的声明会在所在行上被标记出来。以三倍速播放：

{% video "profiler-memory-timelapse" %}

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-leaks.webp" alt="按 HIGH 排序的可疑泄漏，显示以兆字节和对象数计的增长量，以及 SessionCache.cs 中 CustomerSession 声明上的内联 HIGH 泄漏标记" width="2400" height="1500">
  <figcaption>从不淘汰的静态 <code>Dictionary</code> 表现为字节数组、字符串以及持有它们的会话的持续增长。</figcaption>
</figure>

接着，**Show Reference Graph** 会画出是什么让可疑对象一直存活，一路追溯到根。增长是强烈的线索，但不是证据，真正确认泄漏的是保留路径。[修复内存泄漏](/zh/docs/memory-leaks/)指南会一步步带你走完整个流程，从最初的怀疑到经过验证的修复。

## 在 Visual Studio 之外使用 Visual Studio 性能分析器的工作流

如果你用过 [Visual Studio 性能分析器](https://learn.microsoft.com/zh-cn/visualstudio/profiling/profiling-feature-tour)，或者 Rider 中的 [dotTrace](https://www.jetbrains.com/profiler/) 和 [dotMemory](https://www.jetbrains.com/dotmemory/)，就会觉得这套工作流很熟悉。它们都是好工具，但每一个都把性能分析绑定在某个 IDE 上。Visual Studio 只能在 Windows 上运行，而 Microsoft 已在 2024 年[停用 Visual Studio for Mac](https://devblogs.microsoft.com/visualstudio/visual-studio-for-mac-retirement-announcement/)。dotTrace 和 dotMemory 是商业产品。

如今许多 .NET 开发者在 VS Code 或其分支中编写代码。SharpLsp 性能分析器可以在 Windows、macOS 和 Linux 上的 VS Code、Cursor、Windsurf 和 VSCodium 中运行。引擎不需要调试器权限，因此内存跟踪在 macOS 上同样可用。

## 与 dotnet-trace、PerfView 和 BenchmarkDotNet 的关系

.NET 诊断工具非常出色，SharpLsp 也建立在同样的基础之上。它的引擎读取的正是 [dotnet-trace](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/dotnet-trace) 所用的 EventPipe 通道。区别在于答案出现在哪里。

| 工具 | 你得到什么 | 在哪里阅读 |
|---|---|---|
| [dotnet-counters](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/dotnet-counters) | 实时运行时计数器 | 终端 |
| [dotnet-trace](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/dotnet-trace) | 包含 CPU 采样和事件的 `.nettrace` 文件 | PerfView、Visual Studio 或 speedscope |
| [dotnet-gcdump](https://learn.microsoft.com/zh-cn/dotnet/core/diagnostics/dotnet-gcdump) | 堆快照 | PerfView 或 Visual Studio |
| [PerfView](https://github.com/microsoft/perfview) | 对跟踪和堆的深入分析 | 它自己的 Windows 应用 |
| [BenchmarkDotNet](https://benchmarkdotnet.org/) | 单个方法在隔离环境下的精确计时 | 一份报告 |
| SharpLsp 性能分析器 | CPU 采样、堆快照和排序后的可疑泄漏 | 编辑器里你自己的代码 |

当你想分享或保留结果时，跟踪文件仍然有用。每次 SharpLsp CPU 会话都会在 `.sharplsp/profiles` 下写出一个 [speedscope](https://www.speedscope.app/) JSON、一个可以用 VS Code 内置查看器打开的 `.cpuprofile`，以及火焰图 SVG。

BenchmarkDotNet 和性能分析器回答的是不同的问题，所以两者都要用。性能分析器告诉你在真实应用中哪个方法慢。BenchmarkDotNet 告诉你你的修改是否让这个方法变快了。

## C# 与 F#，同一个引擎

引擎附加到的是 .NET 运行时，而不是某种语言，因此 F# 和 C# 使用同一个性能分析器。F# 项目同样能得到热度条、火焰图、内存仪表板和可疑泄漏。SharpLsp 在所有地方都把 F# 当作一等语言，性能分析器也不例外。

## 试一试

1. 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) 安装 SharpLsp；在 Cursor、Windsurf 和 VSCodium 中，从 [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) 安装。
2. 启动你的应用，打开 SharpLsp 视图，在 **Processes** 中找到它。
3. 如果它很慢，点击 **Profile CPU**；如果它的内存一直在涨，点击 **Track Memory**。

引擎需要 .NET 8 或更高版本的运行时。以 `DOTNET_EnableDiagnostics=0` 启动的进程无法附加。[性能分析器文档](/zh/docs/profiler/)介绍了所有命令和设置。
