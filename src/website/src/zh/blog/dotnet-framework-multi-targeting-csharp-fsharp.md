---
layout: layouts/blog.njk
title: "在 VS Code 中使用 .NET Framework 与多目标框架：每个框架，C# 与 F# 皆可"
description: "SharpLsp 0.23 为项目面向的每个框架——.NET Framework、.NET Standard 和现代 .NET——提供完整的 C# 与 F# 语言支持，并带来状态栏框架切换器和可按框架运行的测试资源管理器。支持 Windows、macOS 和 Linux。"
lang: zh
date: 2026-10-13
author: SharpLsp 团队
image: /assets/images/blog/dotnet-framework-multi-targeting-csharp-fsharp.png
imageAlt: 在 net48 处于活动状态时显示 #if NETFRAMEWORK 区域的 F# 和 C# 编辑器，旁边是 SharpLsp 的目标框架选择器
tags:
  - posts
  - csharp
  - fsharp
  - testing
  - dotnet-lsp
category: engineering
excerpt: "真实的库会在同一个项目文件里同时面向 net462 和 net10.0。SharpLsp 0.23 为其中每个框架都提供完整的体验——C# 与 F# 皆然——并让测试资源管理器逐个框架运行测试。"
---

打开几乎任何一个正经的 .NET 库，你都会看到类似这样的一行：

```xml
<TargetFrameworks>net462;net48;netstandard2.0;net8.0;net10.0</TargetFrameworks>
```

一个项目文件，五个框架，还有只在其中一个框架下才会编译的 `#if NETFRAMEWORK` 代码孤岛。大多数编辑器会悄悄只选一个框架，把其余的当作不存在——于是，你正在为 .NET Framework 客户调试的那段代码变成灰色、得不到分析，还满是幻影错误。

**SharpLsp 0.23 为项目声明的每个框架都提供完整的体验，F# 与 C# 完全一样。** 下面看看这在实践中意味着什么。

## 切换框架，代码随之改变

当聚焦的文件属于多目标项目时，状态栏会显示它当前的活动框架，比如 `net48`。点击它（或运行 **SharpLsp: Select Target Framework**）并选择另一个框架。

切换作用于**整个项目，并且两种语言同时生效**：

- `#if NET48` 区域变为活动状态，`#else` 分支变灰；
- 框架专有的 API 得到解析——或者变成它们本来就该报的错误；
- 每个打开文档的诊断都会重新发布；
- 语义高亮、内嵌提示和 CodeLens 立即刷新。

默认值是 `<TargetFrameworks>` 的第一项，与 Visual Studio 一致。

## C#：每个框架一个 Roslyn 上下文

`MSBuildWorkspace` 为每个框架提供一个 Roslyn 项目——`Csv(net48)`、`Csv(net8.0)`——因此每个文档在每个框架下都有一个上下文，每个请求都从**活动**上下文作答。

多目标框架最容易出问题的是项目范围的查询。查找引用、CodeLens 计数、实现、调用层级和类型层级以及死代码分析，都会搜索每个项目的活动框架，并且**每个位置只报告一次**。同一处使用绝不会因为框架不同、或经由属性访问器而被重复计数。

## F#：按框架使用 MSBuild 的选项

F# 得到同样的待遇，而且编译器选项不是猜出来的。对于每个框架，SharpLsp 都会向 MSBuild 请求该项目真实的设计时编译：

```text
dotnet msbuild <fsproj> -p:TargetFramework=net48 -p:DesignTimeBuild=true
  -p:SkipCompilerExecution=true -p:ProvideCommandLineArgs=true ...
  -getItem:FscCommandLineArgs -getItem:ReferencePathWithRefAssemblies
```

因此 `net48` 会使用 `--targetprofile:mscorlib`、4.8 引用程序集以及 `NETFRAMEWORK;NET48;…_OR_GREATER` 进行编译——源文件顺序、通配符、条件和 `Directory.Build.*` 都来自 MSBuild，而不是我们的推测。每个框架大约耗时一秒：第一个在加载时构建，其他的在首次切换时构建，然后保留下来。

有两个细节比看上去更重要：

- **丢弃仅用于控制台的标志。** MSBuild 会为自己的日志传入 `--flaterrors`，把每条编译器消息折叠成一行。保留它的编辑器会让每条诊断、以及每个读取诊断的快速修复都丢失换行。
- **失败时明确降级。** 如果设计时编译失败，项目会回退到它的 `<Compile>` 项，日志会准确说明原因。你得到的是一个能用的编辑器和一句解释，而不是一个悄无声息、只加载了一半的项目。

引用其他 F# 项目的 F# 项目，会按 MSBuild 为该引用实际选定的框架，在内存中读取被引用的项目。

## 在任何操作系统上都能分析

SDK 会自动引用 `Microsoft.NETFramework.ReferenceAssemblies`，因此**在 macOS 和 Linux 上同样可以分析 .NET Framework 代码**——`net48` 的补全、导航和诊断在 MacBook 上也能用。运行则是另一回事：

| 目标 | 分析 | 生成 | 运行 / 测试 | 调试 |
| --- | --- | --- | --- | --- |
| `net462`–`net481` | 所有系统 | 所有系统 | 仅 Windows | 拒绝，并说明原因 |
| `netstandard2.0`/`2.1` | 所有系统 | 所有系统 | 从不——这是库 | — |
| `net8.0`+ | 所有系统 | 所有系统 | 需要对应运行时 | netcoredbg |

缺少运行时的框架——例如只装了 8 和 10 的机器上的 `net9.0`——会被**点名**报告为无法运行，绝不会显示成失败或缺失的测试。

## 懂框架的测试资源管理器

[测试资源管理器](/zh/blog/microsoft-testing-platform-mtp-dotnet-test-csharp-fsharp/)现在能理解多目标测试项目，VSTest 和 MTP 都支持，C# 和 F# 都适用：

- **发现** —— 多目标项目的行会列出它的框架（`net48 · net8.0`），每个测试都会为每个列出它的框架带上 `tfm:<tfm>` 标签。只存在于 `#if NET48` 中的测试只会出现在那里。
- **结果** —— 每个结果都绑定到它的框架。合并后的结果取最差的一个，失败会为每个失败的框架附上一条以 `[net48]` 开头的消息。
- **按框架运行** —— 每个发现的框架都有一个 **Run on `<tfm>`** 配置。它先生成，再对该框架的程序集运行 `dotnet vstest`。绝不使用 `dotnet test --framework`，因为对于每个不面向该框架的项目，它都会以 NETSDK1005 失败。
- **.NET Framework 上的 MTP** —— .NET Framework 的 MTP 模块会作为 `.exe` 直接执行，因为 `dotnet exec` 无法承载桌面 CLR。在 Windows 之外不会启动它，并会明确说明原因。

## 调试：对桌面 CLR 坦诚相告

netcoredbg 能调试 .NET，但不能调试 .NET Framework 的桌面 CLR。一个苦等永远不会附加的调试器的测试宿主只会挂起，所以 SharpLsp 不会让这种事发生：

- 对测试执行**调试**时，会运行所选内容中的 .NET 框架。只包含 .NET Framework 的选择会立即被拒绝，并提示你改用“运行”，或在项目的某个 .NET 框架下调试。
- 在多目标程序上按 **F5**，如果活动框架是 .NET 就调试它，否则调试项目声明的第一个 .NET 框架。
- **Ctrl+F5** 会在不附加调试器的情况下运行 `dotnet run --framework <active>`——包括在桌面 CLR 上运行 .NET Framework 生成。

## 在真实仓库上验证

对于这样的功能，人工构造的测试夹具远远不够。因此，一个 Windows CI 分片会按固定提交克隆三个真实的多目标仓库，并通过真实的扩展驱动它们：

| 仓库 | 语言 | 目标 |
| --- | --- | --- |
| [kekyo/GitReader](https://github.com/kekyo/GitReader) | F# 和 C# | `net35`…`net481`、`netstandard1.6`–`2.1`、现代 .NET |
| [JoshClose/CsvHelper](https://github.com/JoshClose/CsvHelper) | C# | `net462;net47;net48;netstandard2.0;2.1;net8.0;net9.0` |
| [NLog/NLog](https://github.com/NLog/NLog) | C# | `net35;net46;netstandard2.0;netstandard2.1` |

每个仓库都能加载，能在 `#if NETFRAMEWORK` 代码中响应语言请求，能发现它的 .NET Framework 测试程序集，并报告按框架划分的结果。

## 动手试试

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) 或 [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) 更新到 **SharpLsp 0.23** 或更高版本，打开一个多目标解决方案，然后点击状态栏中的框架。

发现哪个项目表现不对？请[提交 issue](https://github.com/Nimblesite/SharpLsp/issues)——一行能让 SharpLsp 出错的真实 `<TargetFrameworks>`，正是我们最想看到的。
