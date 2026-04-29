---
layout: layouts/blog.njk
title: "SharpLsp 介绍：用 Rust 构建的 .NET LSP"
description: "SharpLsp 是一个开源、编辑器无关的 C# 和 F# 语言服务器，用 Rust 构建，由 Roslyn 和 FSharp.Compiler.Service 驱动。无需许可证。没有锁定。支持每一款编辑器。"
lang: zh
date: 2026-03-20
author: Christian Findlay
image: /assets/images/blog/introducing-sharplsp-zh.png
imageAlt: Rust 宿主引擎连接 C# 和 F# sidecar 模块
tags:
  - posts
  - announcement
  - rust
  - csharp
  - fsharp
category: announcement
excerpt: "我们不再等待 Microsoft 修复 .NET 工具链。SharpLsp 是我们的答案：一个由 Rust 承载的 LSP 服务器，为每款编辑器提供一流的 C# 和 F# 支持，并且没有任何专有依赖。"
---

我们已经等够了。

Visual Studio 只属于 Windows，而且笨重庞大。Rider 需要付费许可证。C# Dev Kit 只支持 VS Code，闭源，还把 F# 当作不存在。如果你使用 Neovim、Helix、Emacs 或 Zed，你就在自己的生态系统里成了二等公民。

SharpLsp 是我们的答案。它是一个开源、编辑器无关的 C# 和 F# 语言服务器，用 Rust 构建，由 [Roslyn](https://github.com/dotnet/roslyn) 和 [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) 驱动。MIT 许可。零专有依赖。一次安装，就能服务这台机器上的每一款编辑器。

## 我们已经构建了什么

SharpLsp 不是承诺。它是已经能运行的软件。VS Code 扩展是第一个编辑器集成，但架构从第一天起就刻意保持编辑器无关：一个位于 `$PATH` 上的 `sharplsp-lsp` 二进制文件，任何支持 LSP 的编辑器都可以启动它。

### 解决方案资源管理器

你首先看到的是一个真正的解决方案资源管理器。不是文件树，而是理解 `.sln` 的层级结构，能识别项目、命名空间和类型，行为类似 Visual Studio，但可以出现在每一款编辑器里。

<figure class="article-figure">
  <img src="/assets/screenshots/solution-explorer.png" alt="SharpLsp 解决方案资源管理器在 VS Code 中显示 MyApp.sln 的项目和命名空间树">
  <figcaption>解决方案资源管理器渲染真实 .sln 文件，包含完整的项目和类型层级。</figcaption>
</figure>

侧边栏还显示代码折叠，可以一次点击折叠整个命名空间。这种结构化视图能让大型文件的导航变得可忍受。

<figure class="article-figure">
  <img src="/assets/screenshots/code-folding.png" alt="代码折叠显示折叠后的命名空间，一个视图中可见 60 行代码">
  <figcaption>由 tree-sitter 驱动的代码折叠，亚毫秒完成，不需要编译器。</figcaption>
</figure>

### 代码补全

代码补全来自完整的 Roslyn 语义模型。这意味着导入建议、扩展方法和完整类型上下文，而不只是当前作用域中已经存在的符号。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-completions-page.png" alt="SharpLsp 补全列表显示 Add、Count 和其他带完整语义上下文的成员">
  <figcaption>由 Roslyn CompletionService 驱动的语义补全，与 Visual Studio 背后使用的是同一套引擎。</figcaption>
</figure>

### 悬停提示和 XML 文档

悬停提示显示完整签名、XML 文档和参数说明。侧边栏中的 Profiler 面板在每张截图里都可见：SharpLsp 会显示所有正在运行的 .NET 进程，让你始终知道当前正在执行什么。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-hover-page.png" alt="悬停提示显示 Factorial 方法签名，以及完整 XML 文档和参数说明">
  <figcaption>悬停提示渲染 XML 文档注释，包括参数和返回值文档。</figcaption>
</figure>

### 跳转到定义

跳转到定义可以跨越完整的解决方案图工作，包括嵌套类型，以及其他类内部的成员。面包屑栏会始终跟踪你当前所在的位置。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-go-to-definition-page.png" alt="跳转到定义导航到方法实现，面包屑显示完整类型路径">
  <figcaption>跳转到定义可以穿过多层类型层级。</figcaption>
</figure>

解决方案资源管理器可以正确处理深度嵌套的类结构：内部类、嵌套命名空间，以及所有应当准确反映在树里的结构。

<figure class="article-figure">
  <img src="/assets/screenshots/nested-classes.png" alt="解决方案资源管理器中的嵌套类，显示 Outer、Inner 和 AnotherInner 以及引用计数">
  <figcaption>解决方案资源管理器中的引用计数和嵌套类型支持。</figcaption>
</figure>

### 诊断

诊断来自真正的 Roslyn 编译器，而不是近似实现。SharpLsp 使用 [LSP 3.17 拉取式诊断模型](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_diagnostic)，避免其他工具在工作区加载期间经常出现的幽灵错误。在 MSBuildWorkspace 打开解决方案之前，会先运行 NuGet restore gate，从源头上消除最大一类误报 CS0246。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-diagnostics-page.png" alt="诊断面板显示真实 Roslyn 编译器错误，并包含文件和行引用">
  <figcaption>真实 Roslyn 诊断，按需拉取，永远不会过早推送。</figcaption>
</figure>

### 快速修复和重构

代码操作来自 Roslyn 自己的 CodeFixProviders 和 CodeRefactoringProviders，也就是驱动 Visual Studio 的同一批 provider。移除未使用变量、重命名、提取方法，这些能力都在那里，因为我们调用的是同一套 API。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-refactoring.png" alt="快速修复灯泡显示 Remove unused variable、Fix 和 Explain 选项">
  <figcaption>由 Roslyn 驱动的快速修复，直接呈现在编辑器操作菜单中。</figcaption>
</figure>

### 项目上下文菜单

在解决方案资源管理器中右键点击项目，就能构建、重新构建、清理、浏览 NuGet 包并管理项目引用，所有功能都已经接线并能工作。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-context-menu-open-project.png" alt="项目上下文菜单显示 Build、Rebuild、Clean、Browse NuGet Packages、Add Project Reference 选项">
  <figcaption>直接从解决方案资源管理器上下文菜单执行项目级操作。</figcaption>
</figure>

### NuGet 管理

NuGet 面板是一个完整的包浏览器。你可以搜索、浏览可用包、查看已安装内容、检查包详情，而无需离开编辑器或打开终端。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-search.png" alt="NuGet 浏览器显示 Serilog 包搜索结果和下载次数">
  <figcaption>NuGet 包搜索从 nuget.org 拉取实时结果。</figcaption>
</figure>

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-installed.png" alt="NuGet 已安装包面板显示 Newtonsoft.Json 的描述和版本">
  <figcaption>已安装包标签页显示当前项目中的包。</figcaption>
</figure>

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-package-details.png" alt="Newtonsoft.Json 的 NuGet 包详情面板显示许可证、项目 URL 和版本">
  <figcaption>包详情包含许可证、元数据以及安装和移除操作。</figcaption>
</figure>

## 架构

SharpLsp 是一个三层系统。Rust 宿主负责 LSP 连接、虚拟文件系统，以及所有通过 [tree-sitter](https://tree-sitter.github.io/tree-sitter/) 完成的语法级工作。两个长期运行的 .NET sidecar 进程负责语义分析：一个通过 Roslyn 服务 C#，另一个通过 FSharp.Compiler.Service 服务 F#。

这不是妥协。这是正确的设计。我们不会重新实现类型检查器。我们调用官方编译器。正确性来自这个决定，而不是试图近似 Roslyn 已经知道的东西。

Rust 与 sidecar 之间的 IPC 在 Unix domain sockets 上使用 MessagePack，在 Windows 上使用命名管道，并用 4 字节小端长度前缀分帧。往返开销目标：低于 500 微秒，不包括编译器工作。

纯语法请求，例如 document symbols、folding ranges 和 selection ranges，完全由 Rust 宿主使用 tree-sitter 处理。无论解决方案大小如何，它们都会在 5ms 内返回。语义请求会发送到 sidecar，并通过 150ms debounce window 合并。已经过期的进行中请求会在被新请求取代时取消。

**所有 SharpLsp 二进制文件都集中安装在机器上的同一个位置。** 位于 `$PATH` 上的 `sharplsp-lsp` 就是任何编辑器所需的全部内容。编辑器扩展只是启动系统二进制文件的轻量客户端，不包含任何捆绑可执行文件。一次安装即可同时服务 VS Code、Neovim、Helix、Zed，以及所有其他支持 LSP 的编辑器。

## F# 不是二等公民

其他 .NET 工具要么忽略 F#，要么把它当成事后补上的功能。SharpLsp 不会这样做。C# 和 F# 共享同一层基础设施。它们面向同样的功能目标，也按照同样的标准测试。

F# sidecar 使用 [FSharp.Compiler.Service](https://www.nuget.org/packages/FSharp.Compiler.Service)，并通过 [Ionide.ProjInfo](https://github.com/ionide/proj-info) 解析项目，通过 [FSharpLint](https://github.com/fsprojects/FSharpLint) 提供 lint。F# 专属功能，例如 pipeline hints、union case generation、record stubs、computation expression completions 和 file ordering awareness，都是路线图上的第一优先级项目，而不是未来可有可无的装饰。

## 接下来是什么

第二阶段正在推进：面向两种语言的完整语义分析。这意味着代码补全、悬停提示、跳转到定义、查找引用、诊断、重命名和语义标记，全部在真实 MSBuildWorkspace 加载的解决方案上工作。

接下来是代码操作和重构（第三阶段）、测试发现和调试（第四阶段），最后是其他工具没有的能力：C# 与 F# 项目之间的跨语言导航、架构分析，以及通过 MCP 实现的 AI 辅助代码操作（第五阶段）。

完整路线图在 [技术规格](/docs/specs/sharplsp-spec.md) 中。代码位于 [GitHub](https://github.com/Nimblesite/SharpLsp)。

SharpLsp 存在，是因为 .NET 开发者应该拥有世界级工具，而不该被专有许可证、供应商锁定或单一编辑器绑定所限制。我们正在构建它。欢迎加入。
