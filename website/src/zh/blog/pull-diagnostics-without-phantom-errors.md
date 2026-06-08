---
layout: layouts/blog.njk
title: "诊断准确性：可以信任的错误"
description: "SharpLsp 使用 LSP 3.17 拉取式诊断，提供解决方案级的错误准确性——显示每一个真实的 Roslyn 与分析器错误，且不显示任何不是真实错误的内容。"
lang: zh
date: 2026-04-27
author: SharpLsp 团队
image: /assets/images/blog/pull-diagnostics-without-phantom-errors.png
imageAlt: 编译器诊断流经过滤器，移除错误信号中的误报
tags:
  - posts
  - diagnostics
  - csharp
  - lsp
category: diagnostics
excerpt: "只有当开发者完全信任时，诊断才有用。SharpLsp 的目标是绝对准确：每一个真实错误都显示，每一个误报都被消除。"
---

诊断是开发者反馈循环。Problems 面板是开发者用来理解自己代码是否正确的地方。如果它显示并不存在的错误，开发者就会开始忽略它；如果它漏掉了会让构建失败的错误，开发者就会在 CI 中惊讶地发现问题。两种失败模式都会摧毁人对工具的信任。

SharpLsp 的诊断架构只有一个目标：**准确性**。编译器或分析器会报告的每一个错误都必须出现在编辑器中。任何不会出现在真实构建中的错误都不应出现。Problems 面板应当与 `dotnet build` 告诉你的内容完全一致——不多，也不少。

听起来简单。实际上，这需要围绕工作区生命周期、LSP 协议以及 Roslyn 分析管线的工作方式做细致的工程。

## Roslyn 中"真实"的错误是什么样

[.NET 编译器平台（Roslyn）](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/) 产生两大类诊断，它们各有不同的前缀和严重级别行为。

**编译器诊断**对于 C# 带 `CS` 前缀，对于 F# 带 `FS` 前缀。这些是语言编译器自身产生的错误和警告——类型错误、缺失成员、语法错误、不可达代码。`CS0246` 表示某个类型名无法解析。`CS0019` 表示某个运算符无法应用于操作数类型。这些诊断是权威的：它们反映编译器在完成完整语义分析之后对你代码的理解。

**Roslyn 分析器诊断**带 `CA`（代码质量）或 `IDE`（代码风格）前缀，记录于 [.NET 代码分析概述](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/overview)。Microsoft 的文档写道：

> "Code analysis violations appear with the prefix 'CA' or 'IDE' to differentiate them from compiler errors."
>
> （代码分析违规以 'CA' 或 'IDE' 前缀显示，以与编译器错误区分。）

分析器诊断的[严重级别可配置](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/overview#enable-additional-rules)——可以是建议、警告或错误。当一个团队通过 `.editorconfig`、`<TreatWarningsAsErrors>` 属性或 `<AnalysisMode>` 配置把某条分析器规则设置为 `error` 严重级别时，这些诊断就会让构建失败。它们不是可选的噪声，而是会阻断构建的错误。SharpLsp 必须以与 `CS` 错误同等的醒目程度显示它们，因为从项目角度看它们是等价的。

第三方分析器包——[StyleCop](https://www.nuget.org/packages/StyleCop.Analyzers/)、[Roslynator](https://www.nuget.org/packages/Roslynator.Analyzers/)、[Meziantou.Analyzer](https://www.nuget.org/packages/Meziantou.Analyzer/)、[SonarAnalyzer](https://www.nuget.org/packages/SonarAnalyzer.CSharp/)——接入同一条管线。它们的诊断由 Roslyn 的 `DiagnosticAnalyzer` 基础设施处理，并以相同的严重级别模型上报。SharpLsp 不会把它们当作二等公民。如果某条 StyleCop 规则在你的项目中配置为错误，它就会作为错误出现在 Problems 面板中，因为它本来就会作为错误出现在你的构建中。

## 误报的来源

诊断准确性的敌人是过早断言——在工作区拥有计算正确诊断所需信息之前就显示诊断。

大型 .NET 解决方案不会一次性变成语义完整状态。当一个解决方案打开时，在 Roslyn 能给出权威答案之前，必须发生几件事：

1. **NuGet 还原必须完成。** Roslyn 的 `MSBuildWorkspace` 依赖 `project.assets.json` 来理解包引用及其传递闭包。在该文件最新之前，来自 NuGet 包的类型引用无法解析。在这个窗口期内计算出的任何诊断，都可能为存在于包中的类型报告 `CS0246`——这些错误会在还原完成的瞬间消失。

2. **Source generator 必须运行。**[Source generator](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview) 在编译期产出 C# 文件。如果工作区在生成器执行前产生诊断，对生成类型的引用就会显示为未定义符号——这是另一类不真实的错误。

3. **项目引用必须解析。** 在多项目解决方案中，一个项目的类型图包含被引用项目中定义的类型。如果 Roslyn 还没有加载某个被引用项目，跨项目符号引用就看似未解析。

模式总是相同的：一个急切推送诊断的语言服务器——在工作区还没准备好之前——会产生在技术上与不完整工作区状态一致、但相对编译器实际报告内容是错误的诊断。这些不是编译器的 bug，而是时机问题：服务器断言得太早了。

## LSP 3.17 拉取式诊断模型

SharpLsp 对这个时机问题的解决方案是 [LSP 3.17 拉取式诊断模型](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_diagnostic)。

在传统的推送模型中，语言服务器在自己认为诊断已变化时发送 `textDocument/publishDiagnostics` 通知。服务器控制时机。无论工作区是否处于能产生准确结果的状态，编辑器都会接收服务器发送的内容。

拉取模型把这一点反过来。编辑器在它需要时索取诊断，使用两个 LSP 端点：

- **`textDocument/diagnostic`** —— 拉取特定文档的诊断
- **`workspace/diagnostic`** —— 拉取整个工作区的诊断，让编辑器可以在当前未打开的文件中显示错误

服务器对每次拉取以一个携带**结果标识符**的结果作为响应——这是一个表示当前诊断集合状态的令牌。如果编辑器再次拉取且工作区状态没有变化，服务器可以用 `DocumentDiagnosticReportKind.Unchanged` 响应，跳过冗余计算。这让大型解决方案中未变化文件的重复拉取变得便宜。

当工作区状态确实发生变化——文件被保存、包被还原、项目引用被添加——服务器会发送 `workspace/diagnostic/refresh` 通知。这不是诊断负载，而是一个信号，告诉编辑器它的缓存结果应当被丢弃，并应再次拉取。重新拉取的时机由编辑器控制。服务器无法推送过期结果。

这种设计意味着 SharpLsp 永远不必单方面决定"现在是断言诊断的好时机"。它等编辑器来询问。当被询问时，它要么有可信的答案（工作区已就绪），要么如实告知（工作区仍在加载）。它绝不会编造错误来填补空白。

## NuGet 还原门

.NET 工具中最常见的虚假 CS0246 错误来源，是过期或缺失的 `project.assets.json`——它是告诉编译器去哪里找包程序集的还原图。

在 SharpLsp 用 `MSBuildWorkspace` 打开解决方案之前，它会检查还原状态。如果包未被还原，它会运行 `dotnet restore` 并等待完成，然后才开始加载工作区。诊断管线在工作区进入能解析包引用的状态之前不会开启。

这会给首次打开体验带来延迟——对于在该环境中从未还原过的解决方案，通常是几秒钟。代价是：在该门通过之后，编辑器收到的每一个诊断都是针对一个知道完整包图的工作区计算的。不再有那些只是因为工作区还没加载完才出现的 CS0246 错误。也不再有 30 秒后就消失的红色波浪线。

## 解决方案级诊断

仅对打开文件提供准确诊断是不够的。真实的构建失败往往源自编辑器中未打开的文件。对一个共享类型的破坏性更改会在使用它的每一个文件中引发错误——其中大多数文件可能是关闭的。

SharpLsp 使用 `workspace/diagnostic` 提供解决方案级错误覆盖。当编辑器请求工作区诊断报告时，SharpLsp 会向 Roslyn 查询所有已加载项目中所有文档的诊断。结果覆盖：

- 任何源文件中的所有 `CS`/`FS` 编译器错误
- 来自内置 SDK 分析器和项目引用的任何第三方分析器包的、严重级别为 `error` 或 `warning` 的所有 `CA` 与 `IDE` 分析器诊断
- source generator 产生的、其输出无法编译的任何诊断

结果**不会**包括：

- 针对不完整工作区状态计算出的诊断
- 严重级别低于 `warning`、不会出现在构建中的分析器建议
- 项目图之外的文件中的错误

这与 `dotnet build` 报告的内容一致。Problems 面板显示重要的内容，不显示噪声。

当一个文件发生变化时，sidecar 为该文档计算更新后的诊断，并发送 `workspace/diagnostic/refresh`。编辑器拉取更新后的工作区报告。结果标识符未变化的文件会被服务器跳过——往返成本与实际变化的内容成正比。

## F# 诊断

F# sidecar 通过 `FSharpChecker` 使用 [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) 产生诊断。FCS 诊断带 `FS` 前缀，反映完整 F# 类型检查器对项目的看法——包括可区分联合的穷尽性、缺失的接口实现、未使用的绑定（`FS0026`）以及部分活动模式。

[FSharpLint](https://github.com/fsprojects/FSharpLint) 为 F# 提供分析器层，规则严重级别可配置。被配置为构建阻断的 lint 错误会得到与 Roslyn `CA` 错误相同的处理——它们出现在 Problems 面板中，不会被过滤。

`.fsproj` 中的 F# 文件顺序对编译至关重要。FCS 会针对因为文件顺序不对而产生的前向引用报告错误。SharpLsp 把它们作为真实诊断显示——它们就是真实的构建错误——同时标记顺序来源以便开发者理解修复方法。

## Problems 面板应当告诉你什么

SharpLsp 正在打造的目标，是一个你可以当作构建预言机来对待的 Problems 面板。在你提交之前。在你推送之前。在 CI 运行之前。如果 Problems 面板是空的，构建就通过；如果它有错误，构建就会因这些原因失败。

这需要三件事协同工作：

1. **首次显示就准确**——NuGet 还原门确保工作区在诊断流出之前已就绪
2. **完整覆盖**——工作区诊断覆盖每一个文件，不仅是打开的文件，并包含所有会让构建失败的分析器严重级别
3. **准确失效**——`workspace/diagnostic/refresh` 在文件变化时让编辑器与现实保持同步，而不会过早断言

一个能赢得信任的诊断面板，是开发者不再需要质疑的面板。这就是目标。
