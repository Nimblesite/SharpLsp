---
layout: layouts/docs.njk
title: 性能分析器
lang: zh
eleventyExcludeFromCollections: true
---

![VS Code 中的性能分析器](/assets/screenshots/vscode-profiler-page.png)

# 性能分析器

SharpLsp 在 VS Code 侧边栏中提供 .NET 跟踪、计数器、转储和堆分析工作流。这些操作在 Rust 宿主中运行，不依赖任何一种语言的 sidecar。

## 所需工具

安装你需要的 Microsoft 诊断工具：

```sh
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

SharpLsp 会先检查 `PATH`，然后检查当前用户主目录下的常规 `.dotnet/tools` 目录。它不会运行 `dotnet tool list -g`。如果缺少工具，错误消息会包含对应的安装命令。

## 性能分析器视图

**性能分析器**视图显示：

- 活动的跟踪和计数器会话；
- 可发现的 .NET 进程及其 PID 和命令行；
- 每个会话的输出路径和控制项。

刷新操作会更新进程列表。进程上下文菜单操作可用于启动跟踪、启动计数器、收集转储、复制 PID 或终止进程。

## 跟踪

1. 运行 **SharpLsp: Start Performance Trace** 并选择一个 .NET 进程。
2. 运行 **SharpLsp: Stop Performance Trace**，或从相应树项目停止会话。
3. SharpLsp 会完成 `.nettrace` 文件的写入，将其转换为 SpeedScope JSON，然后打开 SpeedScope 查看器。

如果请求中没有明确指定值，当前跟踪请求默认持续 30 秒，并将文件写入 `.sharplsp/profiles`。打开现有 `.nettrace` 文件也可以将其转换为 SpeedScope 格式。

## 实时计数器

**Start Counter Monitoring** 会为所选进程启动 `dotnet-counters` 并打开实时 Webview。默认提供程序是 `System.Runtime`，刷新间隔为一秒。在会话停止前，计数器更新会通过 `sharplsp/profiler/counterUpdate` 通知到达。

## 转储与堆分析

扩展可以：

- 收集 Heap、Full 或 Mini 转储；
- 运行 `dumpheap -stat` 并显示类型数量和大小；
- 比较两个转储快照；
- 引导完成“基线 → 操作 → 比较”的内存泄漏检测工作流；
- 按地址检查对象；
- 构建有界对象引用图并识别 GC 根。

堆差异分析根据数量和大小的变化对增长嫌疑项进行分类。这些只是启发式结果，并不能证明存在内存泄漏；请结合保留路径和应用行为确认嫌疑项。

## 主要命令

| 命令 | 用途 |
|---|---|
| `SharpLsp: Refresh Profiler` | 刷新进程和会话 |
| `SharpLsp: Start Performance Trace` / `Stop Performance Trace` | 记录并结束跟踪 |
| `SharpLsp: Open Trace File…` / `Convert .nettrace to SpeedScope` | 打开或转换跟踪文件 |
| `SharpLsp: Start Counter Monitoring` / `Stop Counter Monitoring` | 监视运行时计数器 |
| `SharpLsp: Collect Memory Dump` | 捕获内存转储 |
| `SharpLsp: Analyze Heap Dump` | 显示堆统计信息 |
| `SharpLsp: Compare Heap Snapshots` | 比较两个转储的差异 |
| `SharpLsp: Detect Memory Leaks` | 运行引导式快照工作流 |
| `SharpLsp: Show Object Retention Graph` | 可视化对象引用 |
| `SharpLsp: Inspect Object` | 显示一个对象的字段和引用 |

## 配置状态

`sharplsp.toml` 接受[配置](/zh/docs/configuration/)页面中所示的完整性能分析器配置模式。目前只有 `profiler.max_concurrent_sessions` 会应用于运行时行为。其他性能分析器默认字段会被解析，但命令仍使用内置的请求默认值；更改这些字段尚不能重新配置跟踪时长、输出格式、计数器提供程序/间隔或输出目录。

默认会话上限为五个。超过上限时会返回错误，而不是替换现有会话。

## 安全与错误

性能分析器命令会验证 PID、文件、会话 ID 和工具可用性，并通过 LSP 返回错误。进程树中还有一个明确的终止操作；请谨慎使用，因为它会结束所选的外部进程。
