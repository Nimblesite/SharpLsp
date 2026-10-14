---
layout: layouts/blog.njk
title: "在 VS Code 中使用 Windows 上的 .NET Framework：让 net48 与 net10.0 并肩运行和测试，C# 与 F# 皆可"
description: "在 Windows 上，SharpLsp 会在桌面 CLR 上构建、运行和测试 .NET Framework 4.6.2–4.8.1 代码，C# 与 F# 皆可，直接在 VS Code、Cursor 和 Windsurf 中进行，并与同一项目的现代 .NET 构建并列。哪些已经可用、哪些还不行，以及为什么这很重要。"
lang: zh
date: 2026-10-14
author: SharpLsp 团队
image: /assets/images/blog/dotnet-framework-windows-vs-code.png
imageAlt: 多目标项目的 net48 构建在桌面 CLR 上运行，旁边是显示 net48 与 net10.0 结果的测试资源管理器树
tags:
  - posts
  - csharp
  - fsharp
  - testing
  - dotnet-lsp
category: engineering
excerpt: "每天交付的 .NET 中，有很大一部分是 Windows 上的 .NET Framework 4.8。SharpLsp 在每个操作系统上都能编辑它；在 Windows 上，还能与同一项目的 net10.0 构建并列运行和测试它。"
---

大会演讲里讲的 .NET 是 `net10.0`。而每天交付的 .NET 中，有很大一部分是 `net48`：业务系统、WCF 服务、财务团队离不开的 WinForms 工具，还有那个仍有一位重要客户停留在 4.6.2 的库。它们运行在 Windows 上，不会消失，而且常常正是团队无法自己选择编辑器的原因。

[从 0.23 开始](/zh/blog/dotnet-framework-multi-targeting-csharp-fsharp/)，SharpLsp 就能在每个操作系统上分析 .NET Framework 代码。在 Windows 上，它把剩下的工作也做完：**在真正的桌面 CLR 上构建、运行和测试这些代码**，C# 与 F# 皆可，就在你已经在用的编辑器里。

## 为什么这很重要

- **.NET Framework 并没有终止支持。** 不会有 .NET Framework 5，但 4.8.1 作为 Windows 的一部分随系统发布，并随系统一起获得服务。面向它的代码还会被维护很多年。
- **迁移发生在中途。** 没有人会一步到位地移植一个大型代码库。项目会多目标面向 `net48;net8.0`，然后一个一个地迁移，于是同一个文件会在几个月、往往是几年里同时为两个运行时编译。只服务其中一个的编辑器，只服务了一半的迁移。
- **越老的代码越需要工具的帮助。** 在没人记得是谁写的代码里导航、删除之前找出所有引用、每次修改前都运行测试：在一个有十五年历史的代码库里，这就是日常工作。

对许多团队来说，.NET Framework 项目是所有人必须使用同一个 IDE 的最后一个理由。其实不必如此。

## 在 Windows 上可用的功能

| | SharpLsp 做什么 | 适用范围 |
| --- | --- | --- |
| **编辑** | 在 `#if NETFRAMEWORK` 代码中提供补全、导航、诊断和重构，基于 4.x 引用程序集 | 所有操作系统 |
| **构建** | `dotnet build`，引用程序集由 SDK 从 NuGet 拉取，无需安装目标包 | 所有操作系统 |
| **运行** | Ctrl+F5 在桌面 CLR 上运行多目标项目的 `net48` 构建 | Windows |
| **测试** | VSTest 和 MTP 发现并运行每个框架，每个框架一个结果 | Windows |
| **调试** | 带说明地拒绝；请调试同一代码的 .NET 构建 | — |

以上全部覆盖 `net462` 到 `net481`。当前 Windows 10 和 11 中就地安装的 4.8.x 运行时能运行其中每一个。

## 运行：在桌面 CLR 上 Ctrl+F5

在多目标项目中，在状态栏选择 `net48`，然后按 **Ctrl+F5**。SharpLsp 会启动任务 `Run <Project> (net48)`：

```text
dotnet run --project <proj> --framework net48
```

中间没有调试适配器，所以构建会直接在它编译所针对的 CLR 上启动。从项目的某个文件启动时，框架取自状态栏；否则取项目声明的第一个框架。无论哪种情况，输出通道都会记录 `Run: <Project> under net48`。

## 测试：所有框架，一棵树

多目标测试项目在测试资源管理器中只出现一次，它的框架列在该行上：`net48 · net10.0`。

- **每个测试都带有标签**：每个列出它的框架对应一个 `tfm:net48`、`tfm:net10.0`。只存在于 `#if NET48` 中的测试只会出现在那里。
- **每个结果都知道自己的框架。** 合并后的结果取最差的那个，失败会为每个失败的框架各附一条以 `[net48]` 开头的消息。“只在 .NET Framework 上失败”一眼就能看出。
- **Run on `net48`** 是一个独立的运行配置。它先构建，然后只对该框架的程序集运行 `dotnet vstest`。它从不运行 `dotnet test --framework net48`，因为解决方案中每个不面向 `net48` 的项目都会因 NETSDK1005 而失败。

## .NET Framework 上的 MTP：是 .exe，而不是 .dll

面向 .NET 的 Microsoft.Testing.Platform 模块是一个由 `dotnet exec` 托管的 `.dll`。面向 .NET Framework 时，MSBuild 会生成真正的 `<Name>.exe`，而 `dotnet exec` 无法托管桌面 CLR，所以 SharpLsp 直接启动这个 `.exe`。它已通过 C# 的 MSTest 和 F# 的 xUnit v3 测试，二者都在 `net48` 上与 .NET 并列运行。

## F#，条件完全相同

这一切都不是 C# 专属。F# 项目的 `net48` 选项来自 MSBuild 自己的设计时编译：`--targetprofile:mscorlib`、4.8 引用程序集，以及 `NETFRAMEWORK;NET48` 定义。F# 测试项目在 VSTest 和 MTP 下都能在 `net48` 上运行，**Ctrl+F5** 在桌面 CLR 上运行 F# 程序的方式与 C# 程序完全相同。

## 还做不到的：调试桌面 CLR

SharpLsp 内置的是 netcoredbg，一个面向 .NET 的开源调试器。它无法附加到 .NET Framework 的桌面 CLR，而一个等待永远不会到来的调试器的测试宿主只会挂起。所以 SharpLsp 不会让这种情况发生：

- 测试上的 **调试** 会运行所选内容中的 .NET 框架。只包含 .NET Framework 的选择会被立即拒绝，并附上说明原因的消息。
- 在多目标程序上按 **F5** 会调试它的 .NET 框架。

在迁移过程中，这通常已经足够：在 `net10.0` 上调试，在 `net48` 上运行和测试。

## 在 Windows 上构建，在 Windows 上测试

- **仅限 Windows 的 CI。** 四个 VS Code 测试分块只在 Windows 运行器上、通过真实的扩展运行：.NET Framework 项目上的语言服务、测试资源管理器，以及三个固定提交的真实仓库（[GitReader](https://github.com/kekyo/GitReader)、[CsvHelper](https://github.com/JoshClose/CsvHelper) 和 [NLog](https://github.com/NLog/NLog)）。
- 面向 Windows x64 和 Arm64 的 **原生构建**。sidecar 通过命名管道与宿主通信。
- **细节也不放过。** 从 0.25 开始，`PATH` 上的 `.cmd` 或 `.bat` 垫片再也不会挡在内置 sidecar 前面（[#167](https://github.com/Nimblesite/SharpLsp/issues/167)）。Windows 是我们测试的平台，而不是我们移植过去的平台。

## 动手试试

1. 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) 或 [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) 安装 **SharpLsp 0.25** 或更高版本，可用于 VS Code、Cursor、Windsurf 和 VSCodium。
2. 打开一个解决方案，其中包含同时面向某个 .NET Framework 版本和某个 .NET 版本的 SDK 风格项目，例如 `net48;net10.0`。你只需要 .NET 10 SDK：无需目标包，也无需安装 IDE。
3. 在状态栏选择 `net48`，按 **Ctrl+F5**，然后打开测试资源管理器。

整个技术栈都采用 MIT 许可证：无需账户，不计席位，无需续订。如果你的 .NET Framework 项目表现不对，请[提交 issue](https://github.com/Nimblesite/SharpLsp/issues)。来自真实迁移的真实项目文件，正是我们最想看到的。
