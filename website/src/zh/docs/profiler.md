---
layout: layouts/docs.njk
title: 性能分析器
lang: zh
eleventyExcludeFromCollections: true
---

![VS Code 中的性能分析器](/assets/screenshots/vscode-profiler-page.png)

*Alpha 版 VS Code 扩展中的性能分析工作流。*

# 性能分析器

Forge 将 .NET 诊断工作流集成到 VS Code 中。扩展提供进程发现、追踪、计数器、转储、堆分析及相关文件操作命令，性能分析体验仍在为 beta 阶段继续加固。

## 前置要求

全局安装 .NET 诊断工具：

```bash
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

Forge 通过 PATH 和 `dotnet tool list -g` 自动发现这些工具。如果工具缺失，命令会返回带有安装命令的可操作错误。

## 分析器树视图

Forge 侧边栏中的**分析器**面板显示：

| 部分 | 内容 |
|---------|---------|
| **活动会话** | 运行中的追踪和计数器监视器（带会话 ID）|
| **.NET 进程** | 可发现的进程（带 PID 和命令行）|

单击**刷新**更新进程列表。状态栏显示活动分析会话的数量。

## 性能追踪（dotnet-trace）

捕获详细的性能追踪并在 SpeedScope 中查看。

### 开始追踪

1. 在 Forge 侧边栏中打开**分析器**视图
2. 从命令面板运行 `Forge: Start Trace`
3. 从选择器中选择一个 .NET 进程
4. 追踪会话出现在树视图中

### 停止追踪

1. 从命令面板运行 `Forge: Stop Trace`
2. 选择活动追踪会话
3. Forge 将 `.nettrace` 转换为 SpeedScope 格式并自动在浏览器中打开

### 配置

```toml
# forge.toml
[profiler]
default_profile = "cpu-sampling"   # cpu-sampling | gc-verbose | gc-collect | none
default_format = "speedscope"      # speedscope | nettrace | chromium
default_duration = 0               # 秒；0 = 手动停止
max_sessions = 5
```

## 实时计数器监控（dotnet-counters）

以实时更新的表格监控 .NET 性能计数器。

### 开始监控

1. 从命令面板运行 `Forge: Start Counters`
2. 选择一个 .NET 进程
3. 打开一个 webview 面板，显示实时更新的计数器值

### 计数器显示

| 列 | 内容 |
|--------|---------|
| **提供程序** | 计数器提供程序（例如，`System.Runtime`）|
| **计数器** | 计数器显示名称 |
| **值** | 当前值（格式化：字节、计数、百分比）|
| **单位** | 测量单位 |

计数器通过 `forge/profiler/counterUpdate` LSP 通知流式传输。运行 `Forge: Stop Counters` 结束会话。

## 内存转储（dotnet-dump）

捕获和分析内存转储以调查泄漏和高内存使用。

### 收集转储

1. 从命令面板运行 `Forge: Collect Dump`
2. 选择一个 .NET 进程
3. 选择转储类型：**堆**、**完整**或**迷你**
4. Forge 报告输出路径和文件大小

### 分析堆

1. 从命令面板运行 `Forge: Analyze Heap`
2. 选择一个 `.dmp` 文件
3. Forge 运行 `dumpheap -stat` 并显示格式化表格：

| 列 | 内容 |
|--------|---------|
| **类型名称** | 完全限定的 .NET 类型 |
| **数量** | 堆上的实例数 |
| **总大小** | 合计大小（格式化为 B/KB/MB）|

## 堆快照对比

比较两个堆转储以识别增长的类型和内存泄漏。

### 比较快照

1. 从命令面板运行 `Forge: Compare Heap Snapshots`
2. 选择**基线**转储文件（在运行可疑泄漏之前）
3. 选择**对比**转储文件（在运行之后）
4. 对比面板打开，显示：

| 列 | 内容 |
|--------|---------|
| **类型** | .NET 类型名称 |
| **基线数量 / 当前数量** | 前后实例数 |
| **数量变化** | 变化（+/-）|
| **基线大小 / 当前大小** | 内存大小 |
| **大小变化** | 内存变化（+/-）|
| **增长百分比** | 增长百分比 |

**单击任意行**可在对比转储中打开该类型的对象保留图。

### 泄漏嫌疑表

在完整对比上方，Forge 列出按严重性自动分类的**泄漏嫌疑项**：

| 严重性 | 标准 |
|----------|----------|
| 🔴 **高** | 数量增长 >100% 且大小增量 >1 MB |
| 🟡 **中** | 数量增长 >50% 且大小增量 >100 KB |
| 🟢 **低** | 数量增长 >10% 且大小增量 >10 KB |

已知易泄漏类型（`EventHandler`、`CancellationTokenSource`、`Timer`、委托）至少被提升到低严重性。增长的集合（`List`、`Dictionary`、数组）被标记为可能的无界累积。

## 自动泄漏检测

自动运行引导式基线 → 运行 → 对比工作流。

1. 运行 `Forge: Detect Memory Leaks`
2. 选择一个 .NET 进程 — Forge 收集基线转储
3. 在你的应用程序中**运行**可疑的泄漏路径
4. Forge 收集对比转储并自动运行完整的堆对比
5. 对比面板打开，突出显示嫌疑项

## 对象保留图

可视化转储中存活的对象及其在内存中的保留原因。

### 打开图

1. 从命令面板运行 `Forge: Show Object Retention Graph`
2. 选择一个 `.dmp` 文件
3. 输入根对象地址（十六进制，例如 `00007ff812345678`）
4. 交互式力导向图在 webview 面板中渲染

或**单击堆对比**面板中的任意行，以对比转储预加载方式打开图。

### 图控件

| 控件 | 操作 |
|---------|--------|
| **按类型过滤** | 文本输入 — 隐藏类型名称不匹配的节点 |
| **深度滑块** | 将显示节点限制在距根 N 层以内 |
| **导出 SVG** | 将当前图下载为 SVG 文件 |
| **悬停工具提示** | 显示类型、地址、大小、保留大小、实例数 |

### 节点颜色编码

| 颜色 | 含义 |
|-------|---------|
| 🔴 红色 | 泄漏嫌疑项或保留大小较大的 GC 根 |
| 🟠 橙色 | 保留大小较大（>1 MB）|
| 🔵 蓝色 | GC 根（静态字段、线程栈、固定、终结器）|
| ⚫ 灰色 | 普通对象 |

虚线边框 = GC 根。虚线边 = 弱引用。

### 对象检查

1. 从命令面板运行 `Forge: Inspect Object`
2. 选择一个 `.dmp` 文件并输入对象地址
3. 文本面板显示对象的类型、大小、代和所有字段值（带引用地址）

## 命令

| 命令 | 描述 |
|---------|-------------|
| `Forge: Refresh Profiler` | 刷新 .NET 进程列表 |
| `Forge: List Processes` | 刷新并显示 .NET 进程 |
| `Forge: Start Trace` | 开始对 .NET 进程进行性能追踪 |
| `Forge: Stop Trace` | 停止活动追踪并在 SpeedScope 中打开 |
| `Forge: Start Counters` | 开始实时计数器监控 |
| `Forge: Stop Counters` | 停止计数器监控 |
| `Forge: Collect Dump` | 捕获内存转储 |
| `Forge: Analyze Heap` | 从转储文件分析堆统计信息 |
| `Forge: Compare Heap Snapshots` | 对比两个堆转储以查找增长的类型 |
| `Forge: Detect Memory Leaks` | 引导式基线 → 运行 → 对比工作流 |
| `Forge: Show Object Retention Graph` | 交互式对象引用图 |
| `Forge: Inspect Object` | 检查单个对象的字段和引用 |

## 性能目标

| 操作 | 目标 |
|-----------|--------|
| 进程列表刷新 | <500ms |
| 追踪启动延迟 | <1s |
| 计数器更新传递 | 工具输出到编辑器 <100ms |
| 堆分析（50k+ 类型）| <5s |
| GC 根遍历 | <10s |
| 对象图（深度 3，200 节点）| <3s |
| 对象图（深度 5，200 节点）| <8s |
| 堆对比（两个 50k 类型转储）| <10s |
| 图 webview 初始渲染 | <500ms |

## 错误处理

所有分析器命令都能优雅地处理错误：

- **工具未安装**：返回带有确切 `dotnet tool install` 命令的错误
- **无效 PID**：返回错误而不崩溃 LSP 服务器
- **缺少转储文件**：返回清晰的错误消息
- **超出会话限制**：达到最大并发会话时返回错误
- **Sidecar 独立性**：分析器完全在 Rust 宿主中运行；sidecar 崩溃不影响分析
