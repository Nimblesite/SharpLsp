---
layout: layouts/blog.njk
title: ".NET 开发者在应用变慢或内存泄漏时会搜索什么"
description: "五年来关于 .NET 性能分析、CPU、内存和内存泄漏检测的 Google Trends 数据：开发者在应用变慢时输入什么、提到哪些工具，以及 SharpLsp 的性能分析器如何在 VS Code 中回应每一种搜索。"
lang: zh
date: 2026-10-17
author: SharpLsp 团队
image: /assets/images/blog/dotnet-profiler-memory-leak-search-trends.png
imageAlt: Google Trends 柱状图显示 high cpu usage 的搜索量是 cpu profiler 的十五倍，旁边是 VS Code 中 C# 代码上的 SharpLsp 热力图
tags:
  - posts
  - profiling
  - memory-leaks
  - csharp
  - fsharp
category: profiling
excerpt: "“high cpu usage”的搜索量是“cpu profiler”的十五倍，“c# dispose”是“c# memory leak”的七倍。我们读了五年的 .NET 性能分析和内存泄漏 Google Trends 数据，再逐一检查 SharpLsp 在哪里回应这些搜索。"
---

我们读了五年来关于 .NET 性能分析、CPU、内存和内存泄漏检测的 Google Trends 数据。我们想知道：当应用变慢、内存不断攀升时，开发者会输入什么，又会提到哪些工具。简短的结论是：**人们搜索的是症状，而不是工具**，而且越来越多的人在 VS Code 里搜索。

本文逐一介绍数据说明了什么，以及 SharpLsp 性能分析器如何回应每一种搜索。先用一分钟看看性能分析器：

{% video "profiler-film" %}

## 我们如何测量

我们使用 Google Trends：全球网页搜索，按周统计，时间从 2021 年 10 月到 2026 年 10 月。我们每次比较五个搜索词，并查看每个词的热门和上升相关查询。

Trends 的数值是相对值。100 代表*该次比较中*最热门搜索词的最高一周，所以一个数字只有和同一张表里的其他数字放在一起才有意义。年度数字是每周数值的平均值。2021 年只包含最后十一周，2026 年截至 10 月中旬。低于 Google 搜索量下限的词显示为 0。

许多搜索词在 2026 年上升了。同一组比较中的其他词，例如“visual studio profiler”和“high cpu usage”，保持平稳或有所下降，所以这些上升并不是 Google 数据的整体偏移。

## 1. 人们搜索症状，而不是工具

| 搜索词 | 五年平均值 |
|---|---:|
| high cpu usage | 53.2 |
| performance profiler | 6.0 |
| flame graph | 5.5 |
| cpu profiler | 3.5 |
| cpu profiling | 2.5 |

“high cpu usage”的搜索量是“cpu profiler”的十五倍。这些搜索者大多是 Windows 用户和游戏玩家：热门相关查询都与 Windows 11、Chrome 和反恶意软件有关。不过开发者也从同一个地方开始：有东西变慢了，而他们还不知道是什么。

内存也一样。在另一组比较中，“memory leak”平均为 21.0，“memory profiling”为 1.4，同样是十五比一。最大的意图是修复：“fix memory leak”从 2024 年的 10.2 升到 2026 年的 24.2，“how to fix memory leak”增长了两倍多。其中很大一部分来自 Minecraft 玩家，但“how to fix a memory leak”紧跟在那些模组名称之后。

所以 SharpLsp 性能分析器从症状开始。**Processes** 视图列出本机上每个 .NET 进程及其实时 CPU 和内存，在你分析任何东西之前，就能看到哪个进程占满了一个核心、哪个在无限增长。将鼠标悬停在它那一行上，点击 **Profile CPU**。这段录像未经剪辑，以实时速度播放：

{% video "profiler-cpu-recording" %}

热点代码行会在你的代码中亮起，并标出它们占采样的比例。你看到的是具体的行，而不只是方法。

## 2. .NET 性能分析的搜索在增长

| 年份 | .net profiler | java profiler | python profiler | go pprof |
|---|---:|---:|---:|---:|
| 2022 | 7.7 | 32.0 | 42.8 | 15.8 |
| 2023 | 6.6 | 30.3 | 44.7 | 17.4 |
| 2024 | 4.9 | 31.1 | 44.8 | 21.8 |
| 2025 | 8.9 | 26.4 | 42.9 | 20.7 |
| 2026 | 11.8 | 27.6 | 57.6 | 33.2 |

“.net profiler”是四者中最小的，但自 2022 年以来增长了一半，而 Java 性能分析器的搜索在下降。“.net performance”和“c# performance”从 2025 年到 2026 年都大约翻了一番，分别从 15.6 升到 29.6、从 15.3 升到 28.7。它们的上升相关查询都提到了版本：“.net 10”、“performance improvements in .net 8”、“.net aspire”。运行时每年都在变快，随后开发者想找到自己代码中慢的部分。

其他生态系统展示了人们现在想要什么样的性能分析器。Python 的爆发式性能分析器搜索是 memray、Scalene 和 py-spy（+800%）。Java 的是 async-profiler（+2,000%）。它们都是低开销的采样分析器，可以附加到正在运行的进程并绘制火焰图。“flame graph”本身从 2025 年的 5.6 升到 2026 年的 13.9，“cpu profiler”从 2.5 升到 11.2。

这正是 SharpLsp 性能分析器的形态。它通过运行时自己的诊断通道以 100 Hz 采样，附加到已经在运行的进程，无需重启或重新构建。结果面板会打开一个可以放大的火焰图：

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-flamegraph-zoom.webp" alt="放大到 ParseCatalog 的火焰图，显示 System.Text.Json 反序列化调用栈" width="2400" height="345">
  <figcaption>放大到 <code>ParseCatalog</code>：开销来自 System.Text.Json 反序列化器。</figcaption>
</figure>

## 3. 内存排在第一位

当人们搜索“.net profiler”时，相关查询以内存为首：

| 相关查询 | 相对热度 |
|---|---:|
| memory profiler | 100 |
| .net memory profiler | 99 |
| visual studio profiler | 63 |
| .net performance profiler | 60 |
| c# profiler | 44 |

在内存比较中，“memory profiler”从 2025 年的 32.8 升到 2026 年的 47.7，“memory leak detection”几乎增长到原来的三倍，从 9.8 升到 27.3。

## 4. C# 开发者搜索的是机制

| 搜索词 | 五年平均值 |
|---|---:|
| c# performance | 14.7 |
| .net performance | 10.6 |
| c# dispose | 5.9 |
| c# garbage collection | 1.7 |
| c# memory leak | 0.8 |

“c# dispose”的搜索量是“c# memory leak”的七倍。泄漏本身的相关查询是“visual studio memory leak”、“c# dispose”和“what is memory leak”（+170%）。围绕 `Dispose`，上升的查询是“c# using statement”（+120%）和“dependency injection c#”（+90%）。围绕垃圾回收，则是“.net core”（+190%）和面试题。

这与托管代码中内存泄漏的真实成因一致。垃圾回收器会释放所有不再被引用的对象，所以 .NET 中的泄漏是仍被某处持有的对象：从不淘汰的静态缓存、从不移除的事件处理程序，或捕获了 scoped 服务的单例。`Dispose` 释放的是非托管资源，但它不能让仍被引用的对象变得可回收。要找到泄漏，就要观察什么在增长，并追问是什么让它存活。

这正是 **Track Memory** 所做的。内存仪表板在代码旁打开，在应用运行时拍摄堆快照。它按增长的一致性为可疑泄漏排序，并在编辑器中标记泄漏类型的声明。三倍速播放：

{% video "profiler-memory-timelapse" %}

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-leaks.webp" alt="标为 HIGH 的可疑泄漏，显示以 MB 计的增长和对象数，SessionCache.cs 中 CustomerSession 声明处有内联 HIGH 泄漏标记" width="2400" height="1500">
  <figcaption>可疑泄漏。从不淘汰条目的静态 <code>Dictionary</code> 表现为字节数组、字符串以及持有它们的会话对象的持续增长。</figcaption>
</figure>

接着，**Show Reference Graph** 会画出让可疑对象存活的引用，一直追溯到根。因为“fix memory leak”是人们搜索最多的内容，我们写了两篇：[修复内存泄漏](/zh/docs/memory-leaks/)指南逐步介绍整个流程，[如何修复 C# 和 .NET 中的内存泄漏](/zh/blog/how-to-fix-a-memory-leak-in-csharp-dotnet/)则跟踪一个真实的泄漏，从最初的怀疑到验证修复。

## 5. 人们提到的工具都属于某个 IDE

最大的性能分析器搜索词是“visual studio profiler”。它平均为 15.2，五年来一直平稳。“.net memory profiler”会引向“visual studio memory profiler”，而“visual studio performance profiler”正在上升（+250%）。

JetBrains 的相关搜索都与 Rider 有关：“rider”是 dotTrace（+140%）和 dotMemory（+130%）最热门的上升查询。dotTrace 的热度在 2023 年达到 14.6 的峰值，2026 年降到 5.6，这一年 PerfView 超过了它。dotMemory 的爆发式相关搜索中有两个是关于激活码和修改版的。人们想要的是工具，而不是许可证。

与此同时，编辑器变了：

| 年份 | c# dev kit | visual studio profiler | vs code profiler |
|---|---:|---:|---:|
| 2023 | 12.2 | 14.9 | 0 |
| 2024 | 18.1 | 13.5 | 0.2 |
| 2025 | 24.9 | 14.7 | 2.4 |
| 2026 | 48.8 | 15.0 | 6.5 |

C# Dev Kit 的搜索在 2023 年发布后增长到原来的四倍，现在是“visual studio profiler”的三倍。“visual studio code”是“visual studio profiler”的热门相关查询，而且仍在上升（+40%）。开发者想在他们现在写代码的地方使用 Visual Studio 的性能分析器。

SharpLsp 性能分析器可以在 VS Code、Cursor、Windsurf 和 VSCodium 中运行。它采用 MIT 许可证，无需账户。它同样支持 C# 和 F#，因为引擎附加的是 .NET 运行时，而不是某种语言。

## 6. 命令行工具在激增

| 年份 | dotnet-trace | dotnet-counters | dotnet-dump | dotnet-gcdump | perfview |
|---|---:|---:|---:|---:|---:|
| 2024 | 0.8 | 0 | 0.6 | 0 | 10.5 |
| 2025 | 4.8 | 3.6 | 2.3 | 0 | 33.9 |
| 2026 | 12.2 | 14.8 | 1.1 | 0 | 42.2 |

.NET 诊断工具在两年内从几乎无人问津变成了真正的关注点。在另一组比较中，“dotnet monitor”从 2024 年的 2.5 升到 2026 年的 34.4。BenchmarkDotNet 是我们测量到的最大的 .NET 性能搜索词，它在 2026 年翻了一番，从 23.0 升到 47.1。

这些工具都很出色，SharpLsp 的引擎读取的也是和 `dotnet-trace` 相同的 EventPipe 通道。区别在于答案出现在哪里。`.nettrace` 或 `.gcdump` 文件仍需在 PerfView、Visual Studio 或 speedscope 中打开，你在那里读到的是调用栈，而不是你的代码行。SharpLsp 把答案放在编辑器中的那一行上。每次 CPU 会话仍会写出 speedscope JSON、`.cpuprofile` 和火焰图 SVG，方便你分享或保存结果。

## 人们搜索什么，SharpLsp 在哪里回应

| 他们搜索 | SharpLsp 的回应 |
|---|---|
| high cpu usage | **Processes** 中的实时 CPU 列，然后在那一行点击 **Profile CPU** |
| fix memory leak | **Track Memory**、排好序的可疑泄漏，然后是 **Show Reference Graph** |
| .net memory profiler | 内存仪表板：堆时间线、主要分配位置和可疑泄漏 |
| c# dispose, dependency injection | 保留路径，显示是什么仍在持有对象 |
| flame graph | 结果面板中可缩放的火焰图，支持导出 SVG |
| visual studio profiler, in VS Code | 以上全部，在 VS Code 及其分支中提供，采用 MIT 许可证 |
| dotnet-trace, perfview | 相同的运行时通道，答案就在你的代码行上 |

## 试一试

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) 安装 SharpLsp，或在 Cursor、Windsurf 和 VSCodium 中从 [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) 安装。打开 SharpLsp 视图，在 **Processes** 中找到你的应用。引擎需要 .NET 8 或更高版本的运行时。[性能分析器文档](/zh/docs/profiler/)介绍了所有命令和设置。
