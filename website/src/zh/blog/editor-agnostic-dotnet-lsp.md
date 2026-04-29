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
excerpt: ".NET 语言服务器应该是一种平台能力，而不是被困在某个编辑器里的功能。"
---

SharpLsp 是一个面向 C# 和 F# 的开源 .NET 语言服务器。它的目标不是再做一个 VS Code 扩展，而是让 .NET 开发体验可以迁移到任何会说 [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) 的编辑器里。

当前的 SharpLsp alpha 以 VS Code 作为主要工作界面，因为它能让我们快速测试真实工作流：解决方案加载、C# 代码补全、悬停提示、跳转到定义、诊断、NuGet 命令、性能分析器命令和调试器集成。但架构本身不是按 VS Code 的形状设计的。VS Code 是客户端。SharpLsp 才是它背后的语言工具平台。

## 问题在于耦合

.NET 开发者不应该因为最好的 C# 和 F# 工具被锁在某个编辑器里，就被迫按工具选择编辑器。有些团队使用 Visual Studio，有些使用 Rider，有些使用 VS Code。还有一些团队在 Zed、Neovim、Helix、Emacs 或混合环境中工作，根本不可能强制所有人使用同一个编辑器。

这很重要，因为编辑器耦合会制造实际摩擦：

- 设置、快捷键和项目工作流变成编辑器专属知识。
- 当贡献者使用不同编辑器时，团队会失去工具一致性。
- 语言行为泄漏、分叉和分化，最终落在扩展代码里。
- 当产品围绕某个 C# 宿主优化时，F# 支持很容易被不断推迟。

SharpLsp 把编辑器看作共享语言服务外面的一层外壳。LSP 服务器拥有行为。编辑器扩展应该保持轻量。

## SharpLsp 中的“编辑器无关”是什么意思

SharpLsp 围绕一个已安装的 `sharplsp-lsp` 二进制文件构建。编辑器客户端在 `PATH` 上找到它，并通过标准输入和输出启动它。同一个服务器处理 C#、F#、解决方案发现、语义请求、诊断，以及 SharpLsp 自定义请求。

仓库已经体现了这种拆分：

- Rust 宿主负责 LSP 连接、虚拟文件系统、请求路由、tree-sitter 语法工作和 sidecar 生命周期。
- C# sidecar 承载 [Roslyn](https://github.com/dotnet/roslyn)，用于 C# 语义功能。
- F# sidecar 承载 [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/)，用于 F# 语义功能。
- 编辑器扩展暴露原生 UI 能力，同时调用同一套服务器行为。

这就是为什么 VS Code 扩展可以提供解决方案资源管理器和性能分析器视图，而同一个 `sharplsp-lsp` 仍然可以服务那些只支持标准 LSP 能力的编辑器。

## 为什么宿主使用 Rust

Rust 进程负责热路径：协议处理、文档状态、取消、语法级路由和进程监督。这些工作需要可预测的延迟和谨慎的并发。Rust 很适合承担这部分工作。

SharpLsp 不会试图用 Rust 重写 C# 或 F# 编译器。正确的语义行为属于官方编译器栈。当答案依赖符号、类型、项目引用、分析器或编译器服务时，宿主会把请求路由到 Roslyn 和 FSharp.Compiler.Service。

这种拆分让服务器保持快速，同时不假装可以近似出编译器级正确性。

## 这会带来什么

一个编辑器无关的 .NET LSP 会为通常按编辑器碎片化的功能提供同一个集成点：

- 来自同一已安装服务器的 C# 和 F# 语言智能。
- 通过共享 SharpLsp 请求理解解决方案和项目。
- 不只存在于某个 webview 实现里的 NuGet 工作流。
- 可以超越单个扩展宿主的性能分析器和调试器命令。
- 跨编辑器一致的诊断和导航语义。

alpha 仍然专注于先把 VS Code 路径做扎实。这是正确的验证场。长期目标更大：一个开源 .NET 工具栈，一个服务器，每一款编辑器。

## 标准很简单

SharpLsp 应该按它是否让真实 .NET 工作变得更好来评判：打开解决方案、导航代码、修复错误、管理包、分析正在运行的进程，以及在不被迫进入专有工具链的情况下调试。

编辑器应该是偏好。语言工具应该是基础设施。
