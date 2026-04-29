---
layout: layouts/blog.njk
title: "为什么 F# 在 SharpLsp 中是一等公民"
description: "SharpLsp 通过专用 FSharp.Compiler.Service sidecar 设计 LSP，把 F# 当作一等 .NET 语言，而不是后续补上的 C# 专属附加功能。"
lang: zh
date: 2026-04-26
author: SharpLsp 团队
image: /assets/images/blog/why-fsharp-is-first-class-in-sharplsp.png
imageAlt: 函数式编程管道和编译器服务模块位于电路板上
tags:
  - posts
  - fsharp
  - dotnet-lsp
  - language-server
category: fsharp
excerpt: "一等 F# 支持必须是架构级设计。它不能在 C# 专属服务器完成后再补上。"
---

SharpLsp 是一个面向 C# 和 F# 的 .NET 语言服务器。这个说法是有意的。F# 不是未来兼容性说明，不是集成上的事后补充，也不是 C# 旁边的一个勾选框。

一等 F# 支持必须从一开始就设计进语言服务器架构中。如果项目模型、请求路由、测试策略和编辑器体验都先围绕 C# 构建，F# 最终就会变成包在别人假设外面的一层脆弱适配器。

SharpLsp 通过给 F# 自己的语义 sidecar 和 LSP 宿主中的平等地位来避免这个问题。

## F# 有不同的工具需求

F# 不是换了语法的 C#。编译器管线、文件顺序规则、交互式工作流、签名文件、管道密集的代码风格，以及类型推断的人体工学，都需要语言专属处理。

这会影响普通编辑器行为：

- 项目文件顺序会影响编译。
- 悬停提示和补全经常需要清晰显示推断类型。
- `.fs`、`.fsx` 和 `.fsi` 文件需要不同工作流。
- F# Interactive 是核心开发循环，不是新奇玩具。
- 格式化器和分析器预期不同于 C#。

一个认真的 .NET LSP 必须尊重这些差异，同时在共享有意义的地方共享基础设施。

## SharpLsp 的 Sidecar 模型

SharpLsp 使用 Rust 宿主进程处理共享 LSP 行为，并把语义语言工作委托给编译器驱动的 sidecar：

- C# 语义请求发送到 Roslyn sidecar。
- F# 语义请求发送到 [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) sidecar。
- 宿主负责路由、取消、工作区通知、sidecar 生命周期和编辑器协议行为。

这样每种语言都能获得它需要的编译器服务，而不会把 SharpLsp 拆成两个互不相关的产品。共享宿主仍然可以强制共同约束：一个安装位置、一个 `sharplsp` 入口点、一个协议表面，以及一个编辑器集成故事。

## 一等公民在实践中意味着什么

对 SharpLsp 来说，一等 F# 不只是打开 `.fs` 文件不会崩溃。它意味着 F# 功能必须有自己的验收标准：

- F# 项目通过理解 F# 的项目评估加载。
- F# 诊断来自 FSharp.Compiler.Service 和 F# 分析器。
- F# 悬停、补全、定义、引用、重命名和代码操作都作为真实语言功能跟踪。
- F# Interactive 命令以编辑器工作流形式暴露。
- F# 测试覆盖不会因为 C# 路径通过就被视为可选。

其中一部分已经体现在扩展清单和技术规格中，一部分仍在推进。关键在于架构为正确性留出了空间，而不是强迫 F# 穿过 C# 的隧道。

## 共享 .NET 工具仍然重要

一等公民不意味着彼此隔离。C# 和 F# 项目经常存在于同一个解决方案中。开发者仍然需要一个解决方案资源管理器、一个构建故事、一个调试器路径、一个性能分析器和一个包管理界面。

SharpLsp 的职责是在这些共享工作流上保持一致，同时让语言专属编译器服务回答语言专属问题。

这才是真正开源 .NET IDE 后端的形状：生态共享的地方共享基础设施，正确性要求专属处理的地方使用专用语言服务。

## 标准

只有当 F# 开发者可以把 SharpLsp 当作日常工具使用，并且不会觉得自己是在 C# 产品里做客时，F# 支持才算完成。

这就是 SharpLsp 正在追求的标准。
