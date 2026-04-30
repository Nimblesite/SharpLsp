---
layout: layouts/blog.njk
title: "为什么 .NET 需要一个编辑器无关的 LSP"
description: "SharpLsp 正在为 C# 和 F# 构建一个开源 .NET LSP，让语言工具能够跨 VS Code、Zed、Neovim、Helix、Emacs、Rider 等编辑器工作。"
lang: zh
date: 2026-04-28
author: SharpLsp 团队
image: /assets/images/blog/editor-agnostic-dotnet-lsp.png
imageAlt: 多个编辑器窗口连接到同一个中央语言服务器核心
tags:
  - posts
  - dotnet-lsp
  - language-server
category: architecture
excerpt: ".NET 语言服务器应该是一种平台能力，而不是被困在某个编辑器里的功能——而当下，每个选项都有自己的硬伤。"
---

SharpLsp 是一个开源的 C# 和 F# .NET 语言服务器。它的目标不是再多做一个 VS Code 扩展，而是让 .NET 开发体验可以在任何会说 [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) 的编辑器之间迁移——并且让它在任何平台上都能与最好的工具真正一较高下。

这个目标比以往更重要，因为目前 .NET 开发者面对的每一个选项都有一个不容忽视的硬伤。

## Visual Studio 仅限 Windows，没有商量

Visual Studio 是 C# 工具的黄金标准。Roslyn 集成、世界级的性能分析器、XAML 设计器、Test Explorer、Edit and Continue——它是其他一切都要被衡量的基准。而它仅在 Windows 上运行。

Microsoft 在 2024 年 8 月给出了明确确认，[宣布 Visual Studio for Mac 退役](https://devblogs.microsoft.com/visualstudio/visual-studio-for-mac-retirement-announcement/)。他们为 Mac 开发者推荐的路径是：要么使用 VS Code 上的 C# Dev Kit，要么——这是最能说明问题的部分——**在虚拟机里运行完整的 Windows Visual Studio**：

> "Visual Studio IDE running on Windows in a VM on Mac: This option will cover the broadest IDE needs such as legacy project support for Xamarin, F#, and remote development experiences."
>
> （在 Mac 上的虚拟机里运行 Windows 版 Visual Studio：这个方案能覆盖最广的 IDE 需求，例如 Xamarin、F# 的遗留项目支持，以及远程开发体验。）

请再读一遍。Microsoft 对 Mac 上 F# 开发者的官方推荐是去跑一台 Windows 虚拟机。这不是跨平台故事，这是承认 Windows 才是平台，其他都是权宜之计。

## C# Dev Kit 不是替代品

Microsoft 让 Visual Studio for Mac 退役时，把开发者引向了 [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit) 作为替代。但社区的评价并不友好。

C# Dev Kit 目前在 VS Marketplace 上的[**用户评分较低**](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit)——这还是 Microsoft 自家的第一方扩展。最近的评价说明了问题：

> "That just not works out of the box or after basic tinkering. Especially on macOS or Linux... Connection to LSP server just crashes and throws errors." — DKchshv, March 2026
>
> （开箱即用不行，简单折腾一下也不行。在 macOS 或 Linux 上尤其如此……与 LSP 服务器的连接直接崩溃并抛出错误。）

> "It can't find installed .Net runtimes. Isn't this the very first thing it was supposed to do?" — Emre Gönültaş, February 2026
>
> （它找不到已安装的 .Net 运行时。这难道不应该是它要做的第一件事吗？）

> "Installing package 'Language server for Roslyn Copilot integration'. I did not ask for Copilot Integration. I do not want Copilot Integration. I was not asked if I wanted to opt-in. I am not presented with any option to disable it. Disgusting business practice." — Matt Kaczmarek, April 2026
>
> （正在安装 'Language server for Roslyn Copilot integration' 包。我没要求集成 Copilot。我不想要 Copilot 集成。没有人问我是否同意。也没有任何禁用选项。令人作呕的商业行为。）

接下来是许可问题。C# Dev Kit [对企业团队不是免费的](https://marketplace.visualstudio.com/items/ms-dotnettools.csdevkit/license)。任何拥有超过 250 名用户或年收入超过 100 万美元的组织都会被归类为"企业"，**没有付费的 Visual Studio 订阅就不能使用 C# Dev Kit 开发商业应用**。一个开源开发者免费使用，一个商业团队不能。

除了可靠性和许可，功能差距也是真实存在的。C# Dev Kit 没有 CPU 性能分析器，没有内存性能分析器，没有任何性能分析工具。这些在 Visual Studio 中是核心 IDE 功能。在 C# Dev Kit 中根本不存在。

2022 年新 LSP 扩展路线图公告登上 GitHub 时，社区表达了自己的态度：[**1,035 个反对反应**](https://github.com/dotnet/vscode-csharp/issues/5276)——是该仓库历史上反响最负面的公告——发生在 Microsoft 透露新的宿主组件将包含闭源部分之后。这种愤怒并非毫无道理。把工作流建立在开源的 OmniSharp 之上的开发者，被告知替代品将混入他们没有可见性的专有组件。

## Rider 很好——但它是一个独立世界

JetBrains Rider 是一款认真的 IDE。出色的 F# 支持、跨平台、真正的性能分析器、深度的 Roslyn 集成。如果你习惯 IntelliJ 风格的 IDE 并愿意为订阅付费，Rider 是一个真实选项。

但 Rider 是一个与 VS Code 完全不同的开发环境。混合使用编辑器的团队——一些成员用 VS Code，一些用 Neovim，一些用 Zed——无法共享基于 Rider 的工作流。Rider 的 .NET 智能存活在 Rider 内部。它不会暴露一个供其他编辑器消费的标准 LSP 服务器。如果你离开 Rider，就把它的工具一并留下了。

## F# 仍被当作二等公民

F# 是一门世界级的业务系统语言。强类型、代数数据类型、computation expressions，以及一个能在错误进入生产之前捕获大量 bug 的编译器。构建金融系统、数据管线和领域密集型应用的企业，有充分理由选择 F#。

但工具支持讲述了不同的故事。

Visual Studio 的 F# 支持落后 C# 多年。Rider 表现更好。Ionide for VS Code 是一个由社区维护、在真实约束下做严肃工作的扩展。但没有任何故事——无论来自 Microsoft 还是其他人——能让 F# 工具在所有编辑器中与 C# 平起平坐。F# 总是事后补的、附加的功能，是 C# 路线图填满后被推迟的那个。

Microsoft 自己的退役公告就直接承认了这一点。他们列出 Visual Studio for Mac 将失去的内容时，把 F# 专门列为应去运行 Windows 虚拟机的理由。

## 平台问题

所有这些加在一起，就形成了一个碎片化的 .NET 开发体验：

- **Windows**：使用 Visual Studio。同类最佳工具，但被绑定在平台上。
- **macOS/Linux 上的 VS Code**：使用 C# Dev Kit，接受其可靠性问题、许可约束、没有性能分析器，以及 F# 是次要的现实。
- **macOS/Linux 想要完整工具**：使用 Rider，接受订阅成本和它是一个封闭生态的事实。
- **Neovim、Helix、Zed、Emacs**：接受社区从 OmniSharp 或 clangd 启发的配置中拼凑出的任何东西，因为没有任何官方服务器面向你。

不存在一个开源、跨平台、编辑器无关的 .NET 语言服务器，能交付完整画面。

## SharpLsp 在构建什么

SharpLsp 围绕一个已安装的 `sharplsp` 二进制文件构建。编辑器客户端在 `PATH` 上找到它，并通过标准输入和输出启动它。同一个服务器处理 C#、F#、解决方案发现、语义请求、诊断，以及 SharpLsp 自定义请求。

架构是有意拆分的：

- **Rust 宿主**负责 LSP 连接、虚拟文件系统、请求路由、tree-sitter 语法工作和 sidecar 生命周期。
- **C# sidecar** 承载 [Roslyn](https://github.com/dotnet/roslyn)，提供 C# 语义功能。
- **F# sidecar** 承载 [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/)，提供 F# 语义功能。
- **F# 不是事后补上。** 我们尽可能在 C# 功能之前构建 F# 功能，F# 从第一天起就是一等目标。

这就是为什么 VS Code 扩展可以提供解决方案资源管理器和性能分析器视图，而同一个 `sharplsp` 仍然可以服务那些只支持标准 LSP 能力的编辑器。

alpha 阶段聚焦于先把 VS Code 路径做扎实——这是正确的验证场。长期目标是一个开源的 .NET 工具栈，一个服务器，每一款编辑器，并带上一个性能分析器。

## 在实践中是什么样

一个编辑器无关的 .NET LSP 意味着：

- **C# 和 F# 语言智能**来自同一已安装服务器，覆盖 macOS、Linux 和 Windows，无需虚拟机
- **没有按席位付费的许可**。开源。没有企业用户的特殊条款。
- **可用的性能分析器**——不被锁在 Visual Studio 内或 Rider 订阅之后
- **一致的诊断与导航语义**，无论你身处 VS Code、Zed、Neovim 还是 Helix
- **F# 被当作它本身的语言来对待**——而不是等 C# "完成"之后再说

.NET 生态太好了，不该被 Windows、被一个低评分的第一方扩展、或被某一家商业 IDE 厂商绑架。

## 标准很简单

SharpLsp 应该按它是否让真实 .NET 工作变得更好来评判：打开解决方案、导航代码、修复错误、管理包、对正在运行的进程做性能分析、调试——而不会被迫进入专有工具链或 Windows 虚拟机。

编辑器应该是偏好。语言工具应该是基础设施。
