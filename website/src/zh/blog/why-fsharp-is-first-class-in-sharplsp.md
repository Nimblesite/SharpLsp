---
layout: layouts/blog.njk
title: "为什么 F# 在 SharpLsp 中是一等公民"
description: "SharpLsp 把 F# 当作一等 .NET 语言，是因为 F# 社区、编译器、工具栈以及生产成功案例都值得拥有从第一天起就为 F# 而设计的工具。"
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
excerpt: "F# 不是 C# 的支线任务。这门语言、它的社区以及它的生产履历，都值得拥有从一开始就围绕 F# 语义构建的编辑器工具。"
---

SharpLsp 是一个面向 C# 和 F# 的 .NET 语言服务器。这个说法是有意的。F# 不是未来兼容性说明，不是后续补上的集成，也不是 C# 旁边的一个勾选框。

F# 之所以值得一等公民对待，是因为它是一门有严肃社区支持的严肃生产语言。Microsoft 把 F# 描述为一门用于["简洁、健壮、高性能代码"](https://learn.microsoft.com/en-us/dotnet/fsharp/what-is-fsharp)的语言。官方 .NET 语言战略说 F# 开发者["就是喜欢用它工作"](https://devblogs.microsoft.com/dotnet/the-net-language-strategy/)，并表达了让 F# 成为["市面上工具最完善的函数式语言"](https://devblogs.microsoft.com/dotnet/the-net-language-strategy/)的志向。

这是正确的志向。但当下的编辑器现实仍存在差距。

同一份语言战略也说 F# 工具["还达不到"](https://devblogs.microsoft.com/dotnet/the-net-language-strategy/) C# 和 Visual Basic 那种更丰富的体验。这是 2017 年写下的，从那以后的公开社区讨论展现了一个熟悉的模式：语言很优秀，社区很优秀，日常工具体验仍然需要更多投入。

SharpLsp 存在的目的，就是把这份投入做到架构层面。

## 社区已经在做英雄般的工作

任何关于 F# 工具的诚实文章都必须以对建造现有生态的人们的尊重作为起点。F# 社区没有等待完美的厂商支持。他们自己造工具。

[Ionide](https://ionide.io/index.html) 自己的描述很直接：

> "We build cross platform, F# developer tooling" - [Ionide](https://ionide.io/index.html)
>
> （我们构建跨平台的 F# 开发者工具。）

Ionide 的旗舰 VS Code 扩展[下载量超过一百万](https://ionide.io/index.html)，项目本身记录了一条真实的工具链：[FSAutoComplete](https://ionide.io/Tools/fsac.html)、[FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/fcs/)、Fantomas、FSharpLint、analyzers、project info 和 LSP 通信。[Ionide VS Code 概述](https://ionide.io/Editors/Code/overview.html)列出了 F# 开发者期望的高效编辑器功能：自动补全、跳转到定义、工具提示、重命名、重构、快速修复、F# Interactive、工作区错误、项目浏览器、调试器集成等。

那项工作不是脚注。它是过去多年来跨平台 F# 开发能够可行的原因。

社区也看到了这一点：

> Ionide is an absolute treasure.Pioneered so many tooling features that VS and Rider now have too.
>
> - [r/fsharp, "F# Weekly #47, 5 years of Ionide"](https://www.reddit.com/r/fsharp/comments/jy9dgq)
>
> （Ionide 简直是一份珍宝。它开创了许多工具功能，VS 和 Rider 现在也有了。）

那段话之所以重要，是因为它准确地表达了应有的姿态：先感谢。Ionide 和 FSAutoComplete 承担了巨大的工作量。SharpLsp 不是对那项工作的批评。它是一种押注：下一层开放 .NET 工具应当从那项工作中学习、复用正确的编译器原语，并在架构中给 F# 一个更大的位置。

## 痛点也是真实存在的

尊重并不要求否认。F# 开发者一直坦率地谈论体验在何处崩坏。

一位 r/fsharp 用户这样描述 VS Code 体验：

> this does feel very shaky compared to every other language I've worked with.
>
> - [r/fsharp, "Ionide in VS Code (and tooling in general) is pushing me away from F#"](https://www.reddit.com/r/fsharp/comments/t6uyrh)
>
> （与我用过的其他语言相比，这确实感觉很不稳。）

在同一讨论中，具体的失败模式并不抽象：

> Ionide wouldn't stop flagging this code as erroneous until I restarted VSCode altogether.
>
> - [r/fsharp, same thread](https://www.reddit.com/r/fsharp/comments/t6uyrh)
>
> （在我完全重启 VSCode 之前，Ionide 一直把这段代码标记为错误。）

另一位用户给出了更宽厚但仍带条件的评价：

> ionide f# isnt that bad by comparison if you keep project scaffolding "vanilla".
>
> - [r/fsharp, same thread](https://www.reddit.com/r/fsharp/comments/t6uyrh)
>
> （相对而言，如果你的项目脚手架保持"普通"，ionide 的 F# 也不算太糟。）

那个"如果"正是问题所在。认真使用 F# 的用户在真实解决方案中工作，会用到混合项目、生成的资源、包还原、分析器、脚本、多目标框架以及构建逻辑。仅在项目结构保持简单时才能工作的工具，达不到一门一等语言的标准。

这一主题反复出现：

> I love the language and all the rest of the tooling is fantastic at this point, but every time ionide fails to load...
>
> - [r/fsharp, "Ionide doesn't load projects"](https://www.reddit.com/r/fsharp/comments/13wm3gm)
>
> （我喜欢这门语言，到目前为止其他工具也都很出色，但每次 ionide 加载失败时……）

> Yeah the tooling in general feels slower, less reliable than that of more mainstream langs - likely cause less devs, cos, and funding supporting it.
>
> - [r/fsharp, "Why is F# not loved as much as comparable FP-hybrids?"](https://www.reddit.com/r/fsharp/comments/16u52m4)
>
> （是的，整体工具感觉比主流语言慢、不够可靠——可能是因为支持它的开发者、公司和资金更少。）

> The tooling for F# pales in comparison with the tooling for C# though.
>
> - [r/fsharp, "FSharp in VS Code"](https://www.reddit.com/r/fsharp/comments/1bvsyyu)
>
> （但 F# 的工具与 C# 的工具相比仍显黯淡。）

> TBH I'm finding Visual Studio 2019 a more reliable environment for F# coding, I would prefer to use VS Code...
>
> - [r/fsharp, "No red squiggly lines in VS Code / Ionide"](https://www.reddit.com/r/fsharp/comments/p0bh3z)
>
> （说实话，我发现 Visual Studio 2019 写 F# 更可靠，我本来更想用 VS Code……）

这些是个人经验，不是基准数据。但公开的个人经验仍然重要，因为它们准确描述了 SharpLsp 必须改进的用户体验：项目加载、过期诊断、语义延迟、内存压力、编辑器重启，以及对一条波浪线意味着编译器同意你判断的信心。

## 数字说明小众，不是衰弱

Stack Overflow 的 2025 开发者调查报告 F# 的[使用率在所有受访者中为 1.3%，在专业开发者中为 1.2%](https://survey.stackoverflow.co/2025/technology)。这是小众，不是失败。

同一份 2025 调查在编程语言"Admired and Desired"部分报告 F# 的[期望使用率为 2.9%，欣赏度为 49.1%](https://survey.stackoverflow.co/2025/technology)。调查数据有局限，Stack Overflow 的受访者样本也不是普查。但信号与 F# 用户公开发表的看法一致：F# 是一门拥有忠实用户基础的较小语言，不是死路。

2023 年的分析["The State of F#"](https://hamy.xyz/labs/2023-06-state-of-fsharp)从那一年的调查数据中得出了相同的基本结论：使用率低、好感度高、薪资排名在受访者中也很高。它的结论不是 F# 已经主流，而是 F# 是一门已知的小众语言，其用户往往希望继续使用它。

这恰恰是工具最重要的那种语言。一门大语言可以靠生态引力承受平庸的编辑器支持。一门小语言不能。对 F# 而言，优秀工具不是锦上添花，而是采用基础设施。

## F# 在语义上有所不同

F# 不是换了标点符号的 C#。这门语言有不同的编辑需求，而这些需求来自真实的语义。

Microsoft 关于 Visual Studio 16.9 的 F# 工具更新解释了为什么 F# 的语义编辑器功能更难做：因为 F# 使用类型推断，一个源文件的修改会影响项目或解决方案后续位置的类型。该贴文明确指出，依赖类型检查的功能会受到编译器类型检查工作的影响，并指出在大型代码库中修改一个 union case 或被广泛使用的函数返回类型所带来的下游影响。它还解释了为什么签名文件可以通过限制下游类型检查工作量来改善 IDE 性能。来源：[F# and F# tools update for Visual Studio 16.9](https://devblogs.microsoft.com/dotnet/f-and-f-tools-update-for-visual-studio-16-9/)。

仅这一事实就对 LSP 产生巨大影响：

- 项目文件顺序不是装饰性的。F# 的编译顺序会改变语义。
- 悬停提示至关重要，因为推断类型经常没有写在源代码中。
- 补全必须理解类型检查器状态，而不仅是语法。
- `.fs`、`.fsi` 与 `.fsx` 文件具有不同的工作流。
- F# Interactive 是开发循环的一部分。
- 签名文件既是 API 设计工具，也是性能工具。
- Type providers 与 analyzers 制造的语言服务压力，是泛 C# 假设无法覆盖的。

官方 [FSharp.Compiler.Service 文档](https://fsharp.github.io/fsharp-compiler-docs/fcs/)印证了这个架构观点。FCS 暴露用于["自动补全、工具提示、参数信息"](https://fsharp.github.io/fsharp-compiler-docs/fcs/)的编辑器服务，提供整项目分析，承载 F# Interactive，并嵌入编译器。它也是 F# in Visual Studio、FsAutoComplete、Rider 的 F# 支持、.NET Interactive、Fantomas、FSharpLint、Fable 和 WebSharper 等项目所使用的、由编译器支撑的基础。

换言之：真正的 F# 工具从 FCS 开始。它不是从假装可以把 F# 路由到一个 C# 语义模型上开始。

## 好消息正在发生

F# 的工具并非停滞。F# 10 与 .NET 10 一起在 2025 年 11 月发布，包含明确的性能与工具工作。

[Introducing F# 10](https://devblogs.microsoft.com/dotnet/introducing-fsharp-10/) 说该版本包含了一个 type subsumption cache，用以加速类型检查并改善 IDE 响应性，特别是在拥有复杂类型层级的项目中。它还描述了归在 `ParallelCompilation` 项目属性下的并行编译工作、对脚本的 `--typecheck-only` 支持，以及正在进行中的 F# 11 性能与工具升级工作。

F# 10 公告之所以重要，还因为它把工作归功于做事的人。它说 F# 通过 .NET Foundation、F# Software Foundation、成员、贡献者与 Microsoft 之间的协作开发，并表彰社区贡献者在工具、诊断、解析器恢复、测试基础设施和性能改进方面的贡献。它还表彰 [Amplifying F#](https://amplifyingfsharp.io/) 对贡献者的支持。

这就是 F# 故事的一段总结：一个严肃的编译器、一个严肃的开放过程，以及一个持续出现的社区。

## 生产 F# 不是假设

F# 的论据不只是品味问题。这里有真实的生产故事。

官方 [F# testimonials 页面](https://fsharp.org/testimonials/) 包含了在消息基础设施、公共记录分析、Microsoft Bing 广告排名分配与定价、Microsoft Research 生物计算、保险计算、反洗钱、银行、医疗诊断、税务软件、规则引擎、基因组学、卫星系统等领域使用 F# 的公司与团队。

举几个例子：

- [Microsoft Bing 广告排名分配与定价](https://fsharp.org/testimonials/) 报告相关项目代码约 95% 用 F# 开发。
- [Microsoft Research 的生物计算组](https://fsharp.org/testimonials/) 称 F# 为其"科学计算的首选语言"。
- [ClearTax](https://fsharp.org/testimonials/) 表示其"从零开始用 F# 构建了整个产品"。
- [Compositional IT](https://fsharp.org/testimonials/) 报告了一次跨 90 多个市场的复杂规则与数据转换发布，其中"F# 就是好用"。
- [CODE Magazine 的 Jet.com 案例研究](https://www.codemag.com/Article/1611071/F-Microservices-A-Case-Study) 把 F# 微服务作为函数式编程在生产中的"成功的真实案例"。
- Microsoft 自己的 ["Why you should use F#"](https://devblogs.microsoft.com/dotnet/why-you-should-use-f/) 帖子指出 F# 用于"大事"，包括 Jet.com。
- [G-Research](https://www.gresearch.com/news/going-15-percent-faster-with-graph-based-type-checking-part-two/) 公开撰写过他们针对一个大型解决方案中所有 F# 项目验证基于图的类型检查工作，然后证明在该特性开关开启与关闭情况下产生相同二进制输出。

更广泛的社区也有同样的亲历经验：

> I have a job writing F# (had no knowledge before I got it) in the UK.
>
> - [r/fsharp, "FP languages amongst the highest paying ones according to the StackOverflow Survey 2024"](https://www.reddit.com/r/fsharp/comments/1ec75rn)
>
> （我在英国有一份写 F# 的工作（入职前我对它一无所知）。）

> F# has been our primary language for around 6 years now, at least for anything new.
>
> - [r/fsharp, "Who's using F#? What are you using it for?"](https://www.reddit.com/r/fsharp/comments/13m4n7f)
>
> （F# 一直是我们的主要语言，差不多 6 年了，至少所有新东西都用它。）

> Me, we, our company, in production.
>
> - [r/dotnet, "Who's using F#? What are you using it for?"](https://www.reddit.com/r/dotnet/comments/13l6coy/question_whos_using_f_what_are_you_using_it_for/)
>
> （我，我们，我们公司，在生产中使用。）

那些故事不是营销表演。它们证明 F# 已经在承担重要工作。工具应当与这门语言被实际使用的地方相匹配。

## 一等公民在 SharpLsp 中意味着什么

SharpLsp 使用 Rust 宿主进程处理共享 LSP 行为，并把语义语言工作委托给由编译器支撑的 sidecar：

- C# 语义请求发送到 Roslyn sidecar。
- F# 语义请求发送到 [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/fcs/) sidecar。
- 宿主负责路由、取消、工作区通知、sidecar 生命周期与编辑器协议行为。

这种结构本身就是关键。F# 获得 F# 需要的编译器服务。C# 获得 Roslyn。共享宿主处理协议、文件系统、编辑器、缓存、取消和生命周期等不应被重复实现的机制。

对 SharpLsp 而言，一等 F# 意味着具体的产品要求：

- F# 项目通过感知 F# 的项目评估加载。
- F# 诊断来自 FSharp.Compiler.Service 与 F# 分析器。
- F# 悬停、补全、定义、引用、重命名与代码操作作为真实语言功能跟踪。
- F# Interactive 工作流被有意暴露，而不是被当作可选附加。
- `.fs`、`.fsi` 与 `.fsx` 行为分别测试。
- F# 格式化器集成尊重 Fantomas，而不是照搬 C# 的格式化假设。
- F# lint 与分析器工作通过服务器获得一等路径。
- 混合 C# 与 F# 解决方案能正常工作，不会强迫 F# 进入 C# 项目模型。

其中一些已经做完，一些仍在推进。重要的架构选择已经做出：F# 不是支线任务。

## 共享 .NET 工具仍然重要

一等公民不意味着隔离。C# 与 F# 项目经常共存于同一个解决方案。开发者仍然需要一个解决方案视图、一条构建路线、一条调试路径、一个性能分析器，以及一个包管理界面。

正确的模型是在生态共享的地方共享基础设施，在正确性要求的地方使用专属语言服务。

这就是为什么 SharpLsp 拥有一个已安装的服务器和专门的 sidecar。编辑器不应让开发者在 C# 与 F# 质量之间做选择。一个 .NET 解决方案应当感觉像一个解决方案，而每种语言都应获得它应得的编译器智能。

## 标准

只有当 F# 开发者可以把 SharpLsp 当作日常工具使用，并且不会觉得自己是在 C# 产品里做客时，F# 支持才算完成。

F# 社区已经做到了自己的部分。它构建了 Ionide、FsAutoComplete、Fantomas、FSharpLint、Fable、FAKE、Paket、analyzers、文档、演讲、教程和生产系统。它通过开放的设计、开放的实现、开放的社区支持让这门语言持续前行。

SharpLsp 的工作是用架构来回报这份工作，而不是用口号。

F# 是一门一等的 .NET 语言。SharpLsp 正在按此构建。
