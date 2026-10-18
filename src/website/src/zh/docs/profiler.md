---
layout: layouts/docs.njk
title: 性能分析器
lang: zh
eleventyExcludeFromCollections: true
---

# 性能分析器

SharpLsp 可以在不离开 VS Code 的情况下，对任意正在运行的 .NET 进程进行 CPU 和内存分析。热点代码行直接在代码中高亮，火焰图和热点函数表就在旁边，实时堆时间线会在应用运行时为可疑泄漏排序。无需安装 `dotnet-trace`，无需转储，也无需许可证。

{% video "profiler-csharp" %}

## 工作原理

性能分析器运行在 SharpLsp 宿主中，而不是任何一种语言的 sidecar 中，因此 sidecar 重启不会结束分析会话。扩展在 `sharplsp` 可执行文件旁附带一个小型 .NET 引擎，它通过运行时的诊断通道（EventPipe）附加到目标进程：

- CPU 采样和堆快照都可以作用于已经在运行的进程；
- 无需重启或重新构建应用；
- 引擎不需要调试器权限，因此内存分析在 macOS 上同样可用。

引擎需要 .NET 8 或更高版本的运行时。以 `DOTNET_EnableDiagnostics=0` 启动的进程无法附加。

## 进程

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-processes.webp" alt="SharpLsp 侧边栏中的进程视图，列出正在运行的 Storefront .NET 进程及其 Profile CPU 和 Track Memory 操作" width="2400" height="1500">
  <figcaption>进程视图列出每个 .NET 进程的 PID、运行时、CPU 和内存。属于当前工作区的进程会高亮显示。</figcaption>
</figure>

SharpLsp 侧边栏中的 **Processes** 视图会发现本机上的 .NET 进程。每一行显示 PID、运行时版本、CPU 占用和内存，属于当前工作区的进程会高亮显示。将鼠标悬停在某一行上即可看到行内操作：

- **Profile CPU** 附加采样器；
- **Track Memory** 开始跟踪堆。

行的上下文菜单还提供 **Copy PID**、**Reveal Entry in Editor** 和 **Kill Process**。视图工具栏另有三个入口：

- **Run & Profile CPU (Current File)** 和 **Run & Track Memory (Current File)** 会在 SharpLsp 调试器下启动当前项目，并从启动开始分析；
- **Refresh**、**Sort**、**Group** 和 **Filter** 用于整理进程列表。

## CPU 分析

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-live.webp" alt="正在进行的 CPU 分析会话：进程视图显示 Profiling PID，状态栏显示 Profiling" width="2400" height="1500">
  <figcaption>正在进行的会话。点击状态栏项即可停止。</figcaption>
</figure>

在某一行上点击 **Profile CPU**，或运行 **SharpLsp: Start Profiling**（<kbd>Ctrl+Alt+P</kbd>，macOS 上为 <kbd>Cmd+Alt+P</kbd>）。让应用跑过慢的路径，然后运行 **SharpLsp: Stop Profiling**（<kbd>Ctrl+Alt+Shift+P</kbd>，macOS 上为 <kbd>Cmd+Alt+Shift+P</kbd>），或点击状态栏项。**SharpLsp: Take Profile Snapshot** 可以在不停止的情况下查看当前结果。

会话停止后，结果会同时出现在两个地方。

**编辑器中。** 每个热点行都会显示一个内联热力条及其样本占比。热力条按强度从橙色到琥珀色排列，概览标尺也会标记每个热点行，方便跳转。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-heatmap.webp" alt="带有内联热力条的 CheckoutPipeline.cs：ParseCatalog 66.8%，PriceBasket 25.1%，RenderInvoice 7.6%" width="2400" height="1500">
  <figcaption>热力图显示 JSON 解析占用了三分之二的时间，并精确到具体代码行。</figcaption>
</figure>

**结果面板中。** 面板显示样本数、时长、函数数和热点行数，然后是火焰图和带有总占比与自身占比的热点函数表。点击某一行即可打开对应的源代码位置。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-results.webp" alt="SharpLsp Profiler 结果面板：摘要卡片、嵌入的火焰图和热点函数表" width="2400" height="1500">
  <figcaption>结果面板。关闭后可运行 <strong>SharpLsp: Show Profile Results</strong> 重新打开。</figcaption>
</figure>

**Open Interactive Flame Graph** 会打开完整的火焰图。点击某个帧即可放大到它的子树。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-flamegraph.webp" alt="整个分析结果的交互式火焰图" width="2400" height="345">
  <figcaption>完整的分析结果。</figcaption>
</figure>

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-flamegraph-zoom.webp" alt="放大到 ParseCatalog 的火焰图，显示 System.Text.Json 反序列化调用栈" width="2400" height="345">
  <figcaption>放大到 <code>ParseCatalog</code>：开销来自 System.Text.Json 反序列化器。</figcaption>
</figure>

每个会话还会在 `.sharplsp/profiles` 下写入三种导出文件：

- speedscope JSON；
- 可用 VS Code 内置分析查看器打开的 `.cpuprofile`；
- 火焰图 SVG。

{% video "profiler-cpu-recording" %}

## 内存跟踪

在某一行上点击 **Track Memory**，或运行 **SharpLsp: Start Memory Tracking**。**SharpLsp Memory Dashboard** 会在代码旁打开，显示：

- 当前内存、峰值内存和存活对象数；
- 堆时间线；
- 主要分配位置；
- 排序后的可疑泄漏。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-memory.webp" alt="内存仪表板显示持续攀升的堆时间线，并标注 STEADY GROWTH possible leak，旁边是 SessionCache.cs" width="2400" height="1500">
  <figcaption>每次快照后时间线都在上升，图表会标出持续增长。</figcaption>
</figure>

内存自动驾驶会替你拍摄并比较快照：

- 每次调试器暂停时（`sharplsp.profiler.autoSnapshotOnPause`，默认开启）；
- 程序运行期间每隔几秒（`sharplsp.profiler.autoSnapshot`）。

你也可以使用 **Take Memory Snapshot**、**Compare Memory Snapshots** 和 **Force Garbage Collection** 手动操作快照。

可疑泄漏按增长的持续程度排序。每一项都显示以字节和对象数计的增长量，以及连续增长的快照次数。在编辑器中，每个分配内存的类型都会在其声明处显示紫色热力条，可疑泄漏也会标注在同一行。仪表板上的 **Heat map mode** 可以在内存（紫色）和 CPU（橙色）之间切换编辑器的显示。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-leaks.webp" alt="标为 HIGH 的可疑泄漏，显示以 MB 计的增长和对象数，SessionCache.cs 中 CustomerSession 声明处有内联 HIGH 泄漏标记" width="2400" height="1500">
  <figcaption>可疑泄漏。从不淘汰条目的静态 <code>Dictionary</code> 表现为字节数组、字符串以及持有它们的会话对象的持续增长。</figcaption>
</figure>

**SharpLsp: Show Reference Graph** 会为某个类型绘制保留图：持有它的对象，以及让这些对象保持存活的根。堆增长只是启发式判断，并不能证明存在泄漏，请结合保留路径和应用行为确认可疑项。

{% video "profiler-memory-timelapse" %}

## F#

F# 程序可以使用同一个性能分析器，它能读懂 F# 编译器生成的代码。闭包和管道阶段保留编译器给出的名称，例如 `Pipe #1 stage #1 at line 11`。记录、联合和联合用例标在构造它们的行上。由模块值持有的泄漏会以源代码中的写法给出该值的名称。[F# 性能分析](/zh/docs/fsharp-profiling/)用一段演示视频展示了 F# 应用上的完整流程。

## 命令

| 命令 | 用途 |
|---|---|
| `SharpLsp: Profile CPU` / `Track Memory` | 分析所选行对应的进程 |
| `SharpLsp: Run & Profile CPU (Current File)` / `Run & Track Memory (Current File)` | 启动当前项目并从一开始就进行分析 |
| `SharpLsp: Start Profiling` / `Stop Profiling` | 开始或停止 CPU 会话 |
| `SharpLsp: Take Profile Snapshot` | 不停止会话，查看当前结果 |
| `SharpLsp: Show Profile Results` | 重新打开上一次的结果面板 |
| `SharpLsp: Start Memory Tracking` / `Stop Memory Tracking` | 开始或停止堆跟踪 |
| `SharpLsp: Take Memory Snapshot` / `Compare Memory Snapshots` | 拍摄并比较堆快照 |
| `SharpLsp: Force Garbage Collection` | 在快照前执行回收 |
| `SharpLsp: Show Reference Graph` | 显示是什么让某个类型保持存活 |
| `SharpLsp: Refresh Processes` / `Sort Processes` / `Group Processes` / `Filter Processes` | 整理进程列表 |
| `SharpLsp: Copy PID` / `Reveal Entry in Editor` / `Kill Process` | 进程行操作 |

## 设置

| 设置 | 默认值 | 用途 |
|---|---|---|
| `sharplsp.profiler.sampleRate` | `100` | CPU 采样频率（Hz，1–1000） |
| `sharplsp.profiler.lineThreshold` | `1` | 热点行的最小样本占比（%） |
| `sharplsp.profiler.functionThreshold` | `2` | 热点函数的最小样本占比（%） |
| `sharplsp.profiler.showInlineHeatMap` | `true` | 分析后在热点行上绘制热力条 |
| `sharplsp.profiler.maxDiagnosticsPerFile` | `20` | 每个文件的分析标记上限 |
| `sharplsp.profiler.includeNative` | `false` | 在结果中包含本机帧 |
| `sharplsp.profiler.profileOnLaunch` | `false` | 在每个 SharpLsp 调试会话启动时进行分析 |
| `sharplsp.profiler.processRefreshMs` | `2000` | 进程视图的刷新间隔 |
| `sharplsp.profiler.autoSnapshotOnPause` | `true` | 调试器每次暂停时拍摄并比较快照 |
| `sharplsp.profiler.autoSnapshot` | `false` | 内存跟踪期间定时拍摄快照 |
| `sharplsp.profiler.autoSnapshotInterval` | `30` | 定时快照的间隔秒数 |

`sharplsp.toml` 中的 `[profiler]` 表用于设置输出目录（默认 `.sharplsp/profiles`）和热点阈值。参见[配置](/zh/docs/configuration/)。
