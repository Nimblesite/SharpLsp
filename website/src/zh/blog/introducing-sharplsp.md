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

Windows 之外的 .NET 开发体验存在结构性问题。这不是理论，而是有公开证据：[社区以 12 比 1 的悬殊比例反对](https://github.com/dotnet/vscode-csharp/issues/5276) Microsoft 的闭源工具公告，以及一篇让 Mac 开发者去虚拟机里跑 Windows 的退役公告。SharpLsp 是社区给出的答案：一个开源、编辑器无关的 C# 和 F# 语言服务器，用 Rust 构建，由 [Roslyn](https://github.com/dotnet/roslyn) 和 [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) 驱动。MIT 许可。零专有依赖。一次安装，就能服务这台机器上的每一款编辑器。

## 现状比你想象的更糟糕

今天 .NET 开发者面对的每一个选项都有一个让它无法成为答案的硬伤——不是小毛病，而是无法靠补丁修复的结构性问题。理解我们是如何走到今天这一步，对理解 SharpLsp 为什么必须存在、以及为什么半截方案一直未能真正解决问题，非常重要。

近十年来，Visual Studio 之外的 .NET 开发者一直在一个碎片化、不平等且日益专有化的工具生态中摸索前行。OmniSharp 是社区的权宜之计。Ionide 是 F# 社区的权宜之计。各种为 Neovim 和 Helix 维护的 LSP 配置片段，全部都是权宜之计。它们没有一个是真正的答案。Microsoft 一次次让社区承担问题的代价，同时把解决方案的控制权牢牢握在自己手里。

核心问题是结构性的。Microsoft 控制 C# 语言。Microsoft 控制 Roslyn 编译器。Microsoft 控制 VS Code 中占主导地位的扩展命名空间。Microsoft 的商业利益与给开发者世界级、开放、可移植的工具并不一致。Visual Studio 的商业价值部分依赖于平台锁定。C# Dev Kit 对 Microsoft 的价值在于其壮大 VS Code 生态的能力——而不是让它在任何地方都可用。

### Visual Studio：仅限 Windows，没有商量

Visual Studio 仍然只在 Windows 上运行。2023 年 8 月，Microsoft 宣布 Visual Studio for Mac 将于 2024 年 8 月 31 日退役。[官方退役公告](https://devblogs.microsoft.com/visualstudio/visual-studio-for-mac-retirement-announcement/)为需要 F# 的 Mac 开发者列出了如下替代方案：

> **"Visual Studio IDE running on Windows in a VM on Mac: This option will cover the broadest IDE needs such as legacy project support for Xamarin, F#, and remote development experiences on iOS by using a virtual machine (VM)."**
>
> （在 Mac 上的虚拟机里运行 Windows 版 Visual Studio：这个方案能覆盖最广的 IDE 需求，例如 Xamarin、F# 的遗留项目支持，以及通过虚拟机实现的 iOS 远程开发体验。）

这不是替代方案，而是 Microsoft 让 Mac 上的 F# 开发者在自己的电脑里跑一个外来操作系统，去使用他们选择的语言。在 Reddit 的 r/dotnet 上，用户 **AbsurdPreferred** 道出了社区更广泛的反应：

> "This is not surprising to me at all. Visual Studio for Mac is horrible and it was clear that MS didn't care about it at all. I hated using it so much that I switched to Rider on Mac. Then loved that so much, I switched to Rider when I do dev work on PC."
>
> （这一点都不让我意外。Visual Studio for Mac 一直很糟糕，MS 对它显然毫不在意。我在 Mac 上用得太痛苦，干脆换成了 Rider，然后因为太喜欢 Rider，连在 PC 上做开发也改用它了。）

用户 **leeharrison1984** 补充了许多人多年来一直没说出口的话：

> "VS for Mac has been a joke for years and severely lacked features that existed in Windows VS for years. In the last few years, if ever I found myself on a Mac and needed to do some C# work, I'm opening VS Code."
>
> （VS for Mac 多年来一直是个笑话，严重缺少 Windows 版 VS 早已具备的功能。这几年只要我在 Mac 上需要写点 C#，我都会直接打开 VS Code。）

退役本身并不让任何关注此事的人感到意外。Visual Studio for Mac 一直是二线体验——一个从未真正追上 Windows 版本的 Xamarin Studio 改名产品。真正引人注目的是官方明确建议大家去跑 Windows 虚拟机。它印证了生态系统早已默默接受的事实：如果你是 macOS 或 Linux 上认真做事的 .NET 开发者，Microsoft 没有为你准备一个有说服力的故事。

### C# Dev Kit：闭源内核、企业付费门槛、仅限 VS Code

Microsoft 提供的替代品是 [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit)，它在 2023 年发布时遭遇了不友好的反响。在 [GitHub issue #5276](https://github.com/dotnet/vscode-csharp/issues/5276)——也就是 Microsoft 公布扩展 LSP 宿主将包含闭源组件的路线图公告——社区进行了强烈反对。

公告本身有一句关键的话：

> "The 'LSP Tools Host' will not be open-sourced, but we plan to communicate with the community along the way to help guide our future plans."
>
> （"LSP Tools Host" 不会开源，但我们计划在过程中与社区沟通，以指导我们未来的计划。）

GitHub 用户 **GerardSmit** 把根本矛盾讲得很清楚：

> "I feel like Microsoft has noticed the amount of installs the C# extension has and has to step (aka embrace) in. I feel like VSCode was always about (almost) open-source so this feels like a step in the bad direction. Currently the extension has 16M installs. Will all these installs automatically switch to the closed-source part of the extension?"
>
> （我感觉 Microsoft 是看到 C# 扩展的安装量太大才介入（也就是 embrace）的。VSCode 一直以来（几乎）是开源精神的，这个走向感觉很不好。该扩展目前有 1600 万安装。这些安装会自动切换到扩展的闭源部分吗？）

用户 **mhmd-azeez** 提出了显而易见的替代方案：

> "While 'C# in VS Code' getting some love is very much welcome, the new LSP implementation not being open source is a weird decision. I hope Microsoft reconsiders it. If it's about IntelliCode, then they can make the LSP server extensible and open source, with some optional closed source components. GitHub Copilot lives as a separate extension and works everywhere, maybe a similar method can be used for IntelliCode in VS Code too?"
>
> （'C# in VS Code' 得到关注我们当然欢迎，但新的 LSP 实现不开源是个很奇怪的决定。希望 Microsoft 重新考虑。如果是为了 IntelliCode，那完全可以让 LSP 服务器可扩展、开源，再带可选的闭源组件。GitHub Copilot 是独立扩展，能在任何地方工作，VS Code 中的 IntelliCode 也许可以采用类似方式？）

用户 **jasiozet** 说得更直接：

> "It's sad and short-sighted when Microsoft tries to jockey for power in the short-run by making user-hostile decisions. This seems like another instance of embrace/extend/extinguish. It's predictable by now, but I'm not happy about it!"
>
> （Microsoft 用对用户不友好的决策来短期争夺地位，让人遗憾且短视。这看起来又是一次 embrace/extend/extinguish。现在已经能预料到了，但我并不乐见。）

闭源内核还不是唯一问题。[C# Dev Kit 许可](https://marketplace.visualstudio.com/items/ms-dotnettools.csdevkit/license)中包含一项严格的企业限制：任何超过 250 名用户或年收入超过 100 万美元的组织，没有付费的 Visual Studio 订阅，就不能使用该扩展。这道门槛涵盖了大多数获得融资的初创公司、中等规模的工程团队和盈利的小企业。该扩展在公告时已有 1600 万次安装，其中绝大多数用户根本不知道自己受到这条商业许可限制的约束。

C# Dev Kit 还**仅限 VS Code**。它不能在 Neovim、Helix、Emacs、Zed 或任何其他支持 LSP 的编辑器中使用。正如用户 **GerardSmit** 在该 issue 中所言："I assume that Microsoft won't make extensions for these editors."（我猜 Microsoft 不会为这些编辑器做扩展。）他没说错。Microsoft 已经确认：调试器许可不会变更，也没有计划支持非 VS Code 编辑器。如果你的工作流以终端为中心，C# Dev Kit 根本就不是为你设计的。

### OmniSharp：社区的孤儿

OmniSharp 多年来是驱动原版 C# 扩展的开源主力。它跨编辑器、采用 MIT 许可，并由社区维护——理论上是这样。实际上，正如有开发者在 issue #5276 中指出的：

> "We'll see how much love the open-source LSP server will get but I don't have much hope. This year, JoeRobich and 50Wliu have made the most commits and are both working at Microsoft."
>
> （开源 LSP 服务器能得到多少关注我们看着办，但我并不抱太大希望。今年提交最多的是 JoeRobich 和 50Wliu，两人都在 Microsoft 工作。）

OmniSharp 能否继续健康发展，取决于 Microsoft 员工是否选择把它列为优先事项。这不是独立，而是包了一层社区外衣的依赖。当 Microsoft 的战略方向转向新的 LSP 宿主时，开发重心也随之转移。OmniSharp 还没死，但投资并未流向那里。

用户 **codymullins** 提出的担忧贯穿了整个问题空间：

> "Closed tools all get sunset eventually, then we'll have to port all our code. I've worked at places where my whole job was porting from some closed source language that's no longer supported. Better to do it on your own schedule than be forced to unexpectedly. At least with OmniSharp there was a plan b — it wasn't great but it existed."
>
> （闭源工具最终都会被弃用，到时候我们就得迁移所有代码。我在一些公司做过的工作就是把代码从某种已经不再受支持的闭源语言迁出。能按自己的节奏迁移，总比被迫意外迁移要好。至少 OmniSharp 还提供了一个备选方案——虽然不算出色，但它存在。）

### Rider：优秀但闭源

JetBrains Rider 是 Windows 上 Visual Studio 之外最好的 .NET IDE。这是真心的赞誉——Rider 拥有真正出色的 F# 支持、快速的项目加载体验，以及让跨平台 .NET 开发者愿意掏钱的 UI。正如一位 r/fsharp 用户所说：

> "The F# intellisense experience in Rider is rock-solid. Rivals Visual Studio. F# feels like a first-class citizen in Rider." — **Jwosty**, r/fsharp
>
> （Rider 的 F# IntelliSense 体验非常稳定，可与 Visual Studio 媲美。F# 在 Rider 中真的像一等公民。）

r/dotnet 上的用户 **yankun0567** 道出了显而易见的结论：

> "Regarding that VS (not Code!) is Windows only, but .NET is cross-platform — it is no surprise that a cross-platform IDE catches up."
>
> （考虑到 VS（不是 Code！）只在 Windows 上运行，而 .NET 是跨平台的——一个跨平台 IDE 后来居上并不让人意外。）

但 Rider 需要付费商业许可，是闭源的。你的工作流取决于 JetBrains 持续保持其商业可行性以及合理定价。VS for Mac 退役讨论中用户 **ffffrozen** 表达了许多开发者的共同心声：

> "If Rider had a one-off purchase, I'd buy it in a heartbeat."
>
> （如果 Rider 提供一次性买断，我会毫不犹豫地买。）

更根本的一点不是 Rider 不好，而是闭源 IDE 不是开放生态系统的可持续答案。.NET 运行时是开放的。C# 编译器是开放的。F# 编译器是开放的。Language Server Protocol 是开放的。编辑器工具也应该是开放的。

## 我们已经构建了什么

SharpLsp 不是承诺。它是已经能运行的软件。VS Code 扩展是第一个编辑器集成，但架构从第一天起就刻意保持编辑器无关：一个位于 `$PATH` 上的 `sharplsp` 二进制文件，任何支持 LSP 的编辑器都可以启动它。

关键的架构洞察是：我们不会重新实现编译器已经知道的东西。我们调用它们。Roslyn 服务 C#。FSharp.Compiler.Service 服务 F#。所有语义功能——补全、诊断、悬停、跳转到定义、重命名——都通过一个轻量 IPC 桥从真正的编译器获取。我们拥有 LSP 协议层、虚拟文件系统，以及通过 tree-sitter 实现的语法级特性。编译器拥有正确性。这不是妥协，而是正确的设计。

### 解决方案资源管理器

在 SharpLsp 中打开一个 .NET 工作区时，你首先看到的是一个真正的解决方案资源管理器。不是文件树——而是一个理解 `.sln`、能识别项目、命名空间和类型的层级结构，行为类似 Visual Studio，但可以出现在每一款编辑器、每一个平台上。这棵树由真实的 MSBuild 项目图构建，而不是从文件夹结构里猜出来的。它能区分项目引用与 NuGet 依赖，并在侧边栏中如实反映出来。

这件事比听起来更重要。Visual Studio 的解决方案资源管理器自 2002 年以来一直是 .NET 项目的心智模型。它代表了 .NET 开发者思考代码的方式——不是文件夹中的文件，而是解决方案中的项目中的命名空间中的类型。在 Windows 上的 Visual Studio 与 macOS 或 Linux 上其他工具之间切换的资深工程师，能切身感受到失去这种模型的代价。每一个基于文件树的替代方案都会强迫一次心智切换。SharpLsp 拒绝这种切换。解决方案层级是首要导航界面，直接源自 MSBuild，并在你编辑时保持同步。

<figure class="article-figure">
  <img src="/assets/screenshots/solution-explorer.png" alt="SharpLsp 解决方案资源管理器在 VS Code 中显示 MyApp.sln 的项目和命名空间树">
  <figcaption>解决方案资源管理器渲染真实的 .sln 文件，并展开完整的项目和类型层级。</figcaption>
</figure>

这棵树还反映类型级结构。命名空间展开显示类型。类型展开显示成员。每个节点旁内联显示引用计数，让你随时获得使用情况和潜在死代码的环境信号——而不需要对每一个你想了解的符号显式地运行一次 Find All References。当解决方案在磁盘上发生变化——新增文件、修改项目引用——树会无需重启即可更新。

### 代码折叠

大多数编辑器中的代码折叠基于行范围——这是一种粗暴的工具，从开括号折到闭括号，根本不理解自己折的是什么。SharpLsp 的折叠由 tree-sitter 驱动，这意味着它理解代码的语法形态。命名空间、类型、方法和表达式块都能独立、正确地折叠。

折叠范围完全在 Rust 宿主中计算，不涉及任何到编译器 sidecar 的往返。这意味着无论工作区是否完成加载，编译器是否在后台构建中，折叠都能在 1 毫秒内解析。折叠是结构信息，不是语义信息——SharpLsp 据此处理它，把请求路由到最快的处理器上。

<figure class="article-figure">
  <img src="/assets/screenshots/code-folding.png" alt="代码折叠显示折叠后的命名空间，一个视图中可见 60 行代码">
  <figcaption>由 tree-sitter 驱动的代码折叠——亚毫秒级，无需编译器。</figcaption>
</figure>

对于在大型文件中工作的工程师——生成的代码、领域模型、protocol buffer 实现——能在类型级而非行级折叠，是文件可导航与需要不停滚动之间的差异。SharpLsp 的 C# tree-sitter 语法处理所有标准折叠模式，包括 region（用于兼容使用它们的旧代码库）、文档注释块以及多行 LINQ 表达式。

### 代码补全

补全来自完整的 Roslyn 语义模型——也就是驱动 Visual Studio 的同一套 `CompletionService`。这意味着尚未在作用域中的类型导入补全、扩展方法解析、构造函数重载、命名参数建议，以及按访问修饰符过滤。补全列表不是基于词频的猜测，而是对真实编译项目图的 Roslyn 查询。

当你输入一个尚未导入的类型名时，SharpLsp 会带着自动导入建议把它呈现出来。当你输入 `.` 时，你会得到完整成员列表，包含继承成员和来自所有已导入命名空间的扩展方法。当你处于 LINQ 链中时，补全上下文能感知元素类型并相应过滤。这就是 Roslyn 所知道的——SharpLsp 把它直接暴露出来。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-completions-page.png" alt="SharpLsp 补全列表显示 Add、Count 和其他带完整语义上下文的成员">
  <figcaption>由 Roslyn CompletionService 驱动的语义补全——与 Visual Studio 背后使用的是同一套引擎。</figcaption>
</figure>

补全延迟目标是 P50 低于 100ms、P95 低于 200ms。要达到这些目标，需要谨慎管理 sidecar 请求生命周期：当用户继续输入时合并进行中的请求，取消已不再相关的过期补全，以及智能地对到 sidecar 的往返做防抖动，避免对同一文档位置发送重叠请求拖累编译器。当前实现已在一台 M2 MacBook Pro 上的十五个项目解决方案中达到这些目标。

### 悬停与 XML 文档

悬停显示完整的方法或类型签名，并附上其 XML 文档——参数、返回值描述、备注、异常和示例。这些内容由源代码中的 XML 文档注释渲染，或者在悬停第三方 API 时由 NuGet 包中嵌入的文档渲染。Roslyn 的 `DocumentationCommentCompiler` 暴露了所有这些信息，包括来自基类和接口实现的继承文档。

侧边栏中可见的 Profiler 面板并非可有可无的装饰。SharpLsp 显示机器上所有正在运行的 .NET 进程，让你随时知道当前正在执行什么。当你在追查性能回归或确认某个服务确实已经停止时，这种环境进程列表立刻派上用场——你不必打开 Activity Monitor 或运行 `ps aux | grep dotnet`。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-hover-page.png" alt="悬停提示显示 Factorial 方法签名，以及完整 XML 文档和参数说明">
  <figcaption>悬停渲染 XML 文档注释，包括参数和返回值文档。</figcaption>
</figure>

对于 F#，悬停在结构上比 C# 更重要。由于 F# 代码大量依赖类型推断，绑定的类型经常没有在源码中显式写出。在深度嵌套的 `|>` 流水线中，每个中间表达式的类型都由编译器推断——而这是该信息的唯一权威来源。FSharp.Compiler.Service 的 `GetToolTip` API 暴露了这些推断类型，SharpLsp 以与 C# 悬停结果相同的优先级和格式渲染它们。悬停在一个 F# 绑定上会显示其完整的推断类型，而这往往是它存在的唯一文档。

### 跳转到定义

跳转到定义可以在完整的解决方案图中导航——穿越项目引用、进入其他程序集中定义的类型，并在没有可用 PDB 时通过反编译源代码进入 NuGet 包。面包屑栏始终跟踪你在类型层级中的位置，让你在跳转后清楚自己落在哪里，并能沿着访问历史返回。

这不是文本 grep，也不是索引查询。这是 Roslyn 的符号解析——与 Visual Studio 内部使用的是同一机制。它能正确处理部分类、source generator 和嵌套类型，因为 Roslyn 的工作区模型对它们都有考虑。当你对一个由 source generator 定义的符号按下跳转到定义时，SharpLsp 导航到生成的源代码——而不是生成器实现。当你导航到 BCL 类型时，C# sidecar 会用 ICSharpCode.Decompiler 反编译元数据并返回重建的源代码。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-go-to-definition-page.png" alt="跳转到定义导航到方法实现，面包屑显示完整类型路径">
  <figcaption>跳转到定义可以穿过多层类型层级。</figcaption>
</figure>

跳转到反编译元数据中的定义——例如导航进入 `System.Collections.Generic.List<T>` 并查看其实现——历来只有 Visual Studio 和 Rider 才有。它正是让那些工具值得付费的特性之一，因为它免去了你阅读陌生代码时还得开着 docs.microsoft.com 浏览器标签的麻烦。SharpLsp 把这一能力带到每一款运行该二进制的编辑器中。

解决方案资源管理器反映了同样的结构理解。深度嵌套的类型——内部类、嵌套枚举、来自异步方法的编译器生成状态机类型——都会出现在层级中的正确位置，并内联显示引用计数。

<figure class="article-figure">
  <img src="/assets/screenshots/nested-classes.png" alt="解决方案资源管理器中的嵌套类，显示 Outer、Inner 和 AnotherInner 以及引用计数">
  <figcaption>解决方案资源管理器中的引用计数和嵌套类型支持。</figcaption>
</figure>

### 诊断

诊断来自真正的 Roslyn 编译器——不是近似实现，不是 tree-sitter 启发式，也不是对源文本的正则匹配。你看到的每一个错误和警告都是来自完全加载的 `MSBuildWorkspace` 的真实 Roslyn 诊断。决定你的代码是否可编译的同一套分析引擎，也是产生诊断面板的引擎。

SharpLsp 使用 [LSP 3.17 拉取式诊断模型](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_diagnostic)，这意味着诊断只在编辑器请求时计算。它们绝不会在工作区加载期间——项目图不完整、包尚未还原时——被推测式地推送出去。这解决了多年来困扰 VS Code 中 C# 工具的"幽灵错误"问题。任何打开过大型解决方案、看到 OmniSharp 弹出几百个 CS0246 错误又随包加载逐渐消失的人，都明白这件事的重要性。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-diagnostics-page.png" alt="诊断面板显示真实 Roslyn 编译器错误，并包含文件和行引用">
  <figcaption>真实的 Roslyn 诊断，按需拉取，永远不会过早推送。</figcaption>
</figure>

NuGet 还原门会在 `MSBuildWorkspace` 打开解决方案之前运行。SharpLsp 会检测包还原状态，如果缺失就自动运行 `dotnet restore`，然后才开始服务语义请求。首次打开的体验比立刻返回空状态稍慢，但每一个出现的诊断都是真实的——不会有那种仅仅因为工作区还没加载完就出现的红色波浪线。这是 .NET 开发者期望的行为，过去只有在 Visual Studio 或 Rider 中才能获得，因为它们的构建系统集成会确保 IDE 开始分析前包都已就位。

### 快速修复与重构

代码操作来自 Roslyn 自己的 `CodeFixProvider` 和 `CodeRefactoringProvider` 实现——也是驱动 Visual Studio 灯泡菜单的同一批 provider，经过十年生产使用、对几十亿行 C# 代码的打磨。移除未使用变量、添加缺失的 `using`、实现接口、重命名符号、提取方法——所有这些都能用，因为 SharpLsp 调用的是同一套 API，而不是从头重新实现。

这也意味着第三方 Roslyn 分析器自动生效。如果你的项目引用了 Roslyn 分析器 NuGet 包——StyleCop、Roslynator、ErrorProne.NET——它们的诊断规则和代码修复就会出现在 SharpLsp 的操作菜单中，无需额外配置。分析器管线就是 Roslyn 在编译期间运行的同一条管线。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-refactoring.png" alt="快速修复灯泡显示 Remove unused variable、Fix 和 Explain 选项">
  <figcaption>由 Roslyn 驱动的快速修复，直接呈现在编辑器操作菜单中。</figcaption>
</figure>

任何上下文中可用代码操作的清单，都与 Visual Studio 在同一上下文中提供的清单相同，因为从"光标位置和诊断范围"到"可用操作"的代码路径是一致的。我们把文档、位置和诊断上下文传给 Roslyn 的 `CodeFixContext`。剩下的交给 Roslyn。与 Visual Studio 重构菜单的功能对等不是远期愿景——而是这种设计的必然结果。

### 项目上下文菜单

在解决方案资源管理器中右键点击一个项目，就能进行构建、重新构建、清理、浏览 NuGet 以及管理项目引用——所有功能都已经接通并能工作。这些不是 shell 命令的薄包装；它们经过 SharpLsp 服务器，因此能感知解决方案状态，并在引用变化时更新项目图。

构建输出出现在专用面板中，不会与 LSP 日志混在一起。来自构建的错误像 Visual Studio 的错误列表那样链接回编辑器中的源位置。当你通过上下文菜单添加一个项目引用时，`MSBuildWorkspace` 会更新以反映新依赖，解决方案资源管理器树也会更新显示该引用，无需完全重启。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-context-menu-open-project.png" alt="项目上下文菜单显示 Build、Rebuild、Clean、Browse NuGet Packages、Add Project Reference 选项">
  <figcaption>直接从解决方案资源管理器上下文菜单执行项目级操作。</figcaption>
</figure>

项目文件的修改通过 `Microsoft.Build.Construction`——MSBuild 的文档模型 API——完成。这不是字符串操作。当 SharpLsp 添加 `<PackageReference>` 元素时，它会被插入到项目文件 XML DOM 的正确位置，按现有文件的格式一致地排版，并在不破坏空白和注释的前提下序列化回去。这是一条硬性规则：SharpLsp 绝不手工操作结构化文件。

### NuGet 管理

NuGet 面板是一个完整的包浏览器。搜索 nuget.org（或通过 `nuget.config` 配置的任何包源）、浏览可用版本、查看当前安装内容、检查包元数据——全部都不需要离开编辑器或打开终端。搜索结果实时来自 NuGet v3 API，返回包的下载次数、许可证标识符和版本列表。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-search.png" alt="NuGet 浏览器显示 Serilog 包搜索结果和下载次数">
  <figcaption>NuGet 包搜索从 nuget.org 拉取实时结果。</figcaption>
</figure>

包管理对 Visual Studio 之外的 .NET 开发者来说一直是个摩擦点。VS Code 的工作流通常要么使用终端（`dotnet add package Serilog`），要么手工编辑 `.csproj` 并等待还原。两者都不及一个搜索-点击 UI、立刻反馈来得快。SharpLsp 把这套 UI 带到每一款编辑器。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-installed.png" alt="NuGet 已安装包面板显示 Newtonsoft.Json 的描述和版本">
  <figcaption>已安装包标签页显示当前活动项目中的内容。</figcaption>
</figure>

已安装包视图的数据来自 MSBuild 项目图——具体是通过 NuGet 还原图解析的 `PackageReference` 项。这意味着它反映的是项目文件的真实状态，而不是 UI 端缓存。如果你通过终端添加了一个包再打开面板，新包就在那里。如果你直接编辑 `.csproj`，面板会在下次刷新时反映该变化。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-package-details.png" alt="Newtonsoft.Json 的 NuGet 包详情面板显示许可证、项目 URL 和版本">
  <figcaption>包详情包含许可证、元数据以及安装和移除操作。</figcaption>
</figure>

包详情包括 SPDX 许可证标识符、项目 URL、作者信息，以及该包在所配置 feed 上的完整版本历史。这是 Visual Studio NuGet 包管理器中的详细级别，现在通过一个共享的服务器进程在每一款支持 LSP 的编辑器中都能获得。

## 架构

SharpLsp 是一个三层系统。Rust 宿主负责 LSP 连接、虚拟文件系统，以及所有通过 [tree-sitter](https://tree-sitter.github.io/tree-sitter/) 完成的语法级工作。两个长期运行的 .NET sidecar 进程负责语义分析——一个通过 Roslyn 服务 C#，另一个通过 FSharp.Compiler.Service 服务 F#。

用 Rust 构建宿主不是出于猎奇。Rust 通过 tokio 提供零成本异步运行时，为多编辑器共享服务器场景提供无畏并发，以及一个启动时间小于 50ms、在 sidecar 连接前内存消耗微乎其微的二进制文件。宿主处理 LSP 消息、管理虚拟文件系统、路由请求并执行 tree-sitter 解析——全程不会以会干扰 sidecar 进程垃圾回收的方式触碰堆。

将语义分析保留在 .NET 中同样是有意为之。Roslyn 是一个托管运行时库。FSharp.Compiler.Service 是一个托管运行时库。两者都是为各自语言精心打造、长期维护的实现，背后是数十年的工程积累，用任何其他语言重新实现它们都不理智。我们调用它们就好。sidecar 是长期运行的 .NET 进程，加载完整的 MSBuildWorkspace、维护内存中的编译器状态，并响应来自 Rust 宿主的 IPC 请求。

Rust 与 sidecar 之间的 IPC 在 Unix domain sockets 上使用 MessagePack（Windows 上使用命名管道），并以 4 字节小端长度前缀分帧。本地基准测试显示往返 IPC 开销稳定低于 200µs，这意味着瓶颈始终是编译器操作——而不是传输。包括 IPC 在内的总往返开销目标：低于 500µs（不计编译器工作）。

纯语法请求——document symbols、folding ranges、selection ranges——完全由 Rust 宿主使用 tree-sitter 处理。无论解决方案大小如何，它们都在 5ms 内返回。语义请求会发送到 sidecar，并通过 150ms 的防抖动窗口合并。已经过期的进行中请求会在被同一文档的新版本取代时取消。

| 类别 | 处理者 | 延迟目标 | 示例 |
|------|--------|---------|------|
| 纯语法 | Rust（tree-sitter） | &lt;5ms | documentSymbol、foldingRange、selectionRange |
| 语义 | Sidecar（Roslyn/FCS） | &lt;200ms | completion、hover、definition、references |
| 混合 | Rust + Sidecar | &lt;100ms | semanticTokens |
| 缓存 | Rust（salsa） | &lt;1ms | 未变化文档的重复请求 |

**所有 SharpLsp 二进制文件都集中安装在机器上的同一个位置。** `$PATH` 上的 `sharplsp` 就是任何编辑器所需的全部内容。编辑器扩展只是启动系统二进制文件的轻量客户端——不包含任何捆绑的可执行文件。一次安装即可同时服务 VS Code、Neovim、Helix、Zed，以及所有其他支持 LSP 的编辑器。

这解决了当前生态中最荒谬的现象之一：每个编辑器扩展都捆绑了自己的语言服务器二进制副本。OmniSharp VS Code 扩展捆绑了一份 OmniSharp 二进制。Ionide 扩展捆绑了自己构建的 F# 语言服务器。这些二进制按扩展、按编辑器、按机器分别下载。它们不共享进程，也不共享缓存。同时使用 VS Code 和 Neovim 处理同一解决方案的开发者，理论上会运行两个独立的 OmniSharp 实例——每个都在内存中维护自己的一份 Roslyn 工作区。SharpLsp 每个解决方案只运行一个进程，由机器上所有编辑器共享。

## F# 不是事后补上的

Microsoft 的退役公告告诉 Mac 上的 F# 开发者去运行 Windows 虚拟机。C# Dev Kit 没有 F# 支持。issue #5276 中的 Language Server Protocol 公告对 F# 一字未提。OmniSharp 的 F# 故事一直是次要的。社区多年来接受这种状况，是因为没有别的选择。SharpLsp 拒绝接受。

Windows 和 Rider 之外的 F# 工具状态一直是持续的挫败之源，并已可观测地拖慢了语言的采用。一个标题为"[Editing F#: A big issue preventing adoption and onboarding](https://www.reddit.com/r/fsharp/comments/bngxxz/editing_f_a_big_issue_preventing_adoption_and/)"的 r/fsharp 帖子，在 2019 年总结了这件事，今天仍然准确。用户 **flubahdubah** 写道：

> "I'm here to make the argument that fixing the editor tooling should be a higher priority item to fix for the F# team, ahead of some of the current release items that (while appreciated and important) do not fix as large of an issue. We use editor tooling in every single programming task — versus a language feature which might only be present in certain programming tasks. Having a base set of reliable editing features can signal the maturity of a language's ecosystem."
>
> （我想表达的观点是：修复编辑器工具应该成为 F# 团队的更高优先级，排在某些当前发布事项（虽然也值得肯定且重要）之前——因为这些事项解决的问题没有这个大。编辑器工具是我们每一个编程任务都要用的，而某个语言特性可能只在特定任务中出现。拥有一组基础可靠的编辑功能，可以体现一门语言生态的成熟度。）

同一帖子中，一位匿名评论者指出了 F# 与类型推断之间在结构上的重要事实：

> "Another issue is that since most F# code uses type inference so heavily, it's even more important than normal to have an editor with IDE features, so you can tell what types things are. Code you wrote a long time ago, or someone else's code, that doesn't have type annotations is completely impenetrable without a code editor that can show you the types in some way, and let you hop to definition."
>
> （另一个问题是，由于大多数 F# 代码大量使用类型推断，拥有 IDE 级编辑器就比平时更重要——这样你才知道东西的类型是什么。没有类型注解的旧代码或别人写的代码，如果没有能用某种方式显示类型并跳转到定义的编辑器，根本无从理解。）

正因如此，F# 的编辑器质量不仅是体验问题——它是正确性问题。如果悬停时类型显示不准确，大量依赖推断的 F# 代码就会变得难以阅读和维护。编辑器不是便利，而是文档。当编辑器变慢、在负载下崩溃，或在文件改动后失去对类型的跟踪时，语言本身就变得更难接近。

最近一个 r/fsharp 编辑器讨论中，用户 **bozhidarb** 描述了更广泛的问题：

> "I'm not sure the support for F# in NeoVim is very good — I played with OCaml there and the indentation was quite broken when using TreeSitter. I checked Helix briefly and the support story there wasn't very good either. That's a big problem with smaller communities — the languages are great, but the support for them in editors is all over the place."
>
> （我不确定 NeoVim 中的 F# 支持有多好——我在那里玩过 OCaml，使用 TreeSitter 时缩进就相当糟糕。我也简单看了 Helix，那里的支持故事也不太好。这是较小社区面临的一大问题——语言本身很优秀，但它们在编辑器中的支持参差不齐。）

而 F# 工具状态帖子中用户 **verdadkc** 描述了当前情况制造的入门门槛：

> "Learning a new language is the fun and easy part. Learning a new tooling ecosystem is daunting and tedious. I would love to see a course on .NET for people who are entirely new to .NET and have no intention of ever using Visual Studio."
>
> （学习一门新语言是有趣且轻松的部分。学习一个新的工具生态则令人却步且乏味。我特别希望能有一门面向完全没有 .NET 经验、且根本不打算使用 Visual Studio 的人的 .NET 课程。）

SharpLsp 直接回应这些诉求。C# 和 F# 共享同一层基础设施。它们对齐相同的功能目标。它们按相同的标准接受测试。F# 不是事后补上——它从第一天起就是一等目标。

F# sidecar 运行 [FSharp.Compiler.Service](https://www.nuget.org/packages/FSharp.Compiler.Service)，配合 [Ionide.ProjInfo](https://github.com/ionide/proj-info) 解析项目，并使用 [FSharpLint](https://github.com/fsprojects/FSharpLint) 提供 lint。F# 专属功能——管线类型提示（在 `|>` 链中内联显示中间类型）、union case 生成、record stub 补全、computation expression 补全、`.fsproj` 中的文件顺序感知，以及带 NuGet 引用补全的 `.fsx` 脚本支持——都是路线图上的第一优先级项目，而不是未来可有可无的装饰。

我们正在构建的标杆，就是 **Jwosty** 在 r/fsharp 描述 Rider F# 支持时所说的：

> "The F# intellisense experience in Rider is rock-solid. Rivals Visual Studio. F# feels like a first-class citizen in Rider."
>
> （Rider 的 F# IntelliSense 体验非常稳定，可与 Visual Studio 媲美。F# 在 Rider 中真的像一等公民。）

我们要在开源、跨编辑器、跨平台的环境中实现这一标准。当我们添加一个新功能时，F# 与 C# 同时获得它。

## 为什么开源所有权重要

社区对 #5276 公告的不满，并非关于开源的抽象意识形态。它关乎控制——具体说是关乎能否预测自己工具下一步会做什么、在它出问题时能否分支、在厂商改变方向时能否迁移走的能力。正如 **codymullins** 在该帖中所说：

> "Closed tools all get sunset eventually, then we'll have to port all our code. I've worked at places where my whole job was porting from some closed source language that's no longer supported. Better to do it on your own schedule than be forced to unexpectedly."
>
> （闭源工具最终都会被弃用，到时候我们就得迁移所有代码。我在一些公司做过的工作就是把代码从某种已经不再受支持的闭源语言迁出。能按自己的节奏迁移，总比被迫意外迁移要好。）

这种模式在行业中反复出现。商业厂商提供出色工具。社区对它产生依赖。厂商更改定价、修改许可条款、停用某项功能或调整产品方向。社区开始手忙脚乱。这件事在 Visual Studio for Mac 上发生过。在 Xamarin 上发生过。在 .NET 整体跨平台故事上也发生过——直到围绕 .NET Core 的社区压力迫使 Microsoft 转向。

开源不是质量保证——OmniSharp 也有 bug。但它是延续性和控制权的保证。当源码存在并以 MIT 许可发布，社区就可以分支、维护、改进它，并把它集成到其他工具中，而无需许可。任何一家公司都不能在一夜之间将其废弃。

SharpLsp 采用 MIT 许可。完整源码在 [GitHub](https://github.com/Nimblesite/SharpLsp) 上。没有闭源组件，没有企业许可限制，也不需要 Microsoft 账户。任何规模的组织都不会被排除在商业使用之外。没有任何东西需要签署。

## 接下来是什么

第二阶段正在推进：面向两种语言的完整语义分析。这意味着补全、悬停、跳转到定义、查找引用、诊断、重命名和语义标记——全部在真实 MSBuildWorkspace 加载的 C# 解决方案与 FCS 加载的 F# 项目上工作。

之后是代码操作和重构（第三阶段）、测试发现和调试（第四阶段），最后是其他开源工具不曾提供的功能——同一解决方案中 C# 与 F# 项目之间的跨语言导航、架构分析，以及通过 MCP 实现的 AI 辅助代码操作（第五阶段）。

跨语言导航功能值得特别一提。在真实的 .NET 解决方案中，C# 和 F# 项目并存非常常见——例如一个 F# 领域模型库被 C# ASP.NET Core API 消费。在所有现有开源工具中，对一个调用 F# 类型的 C# 代码点击跳转到定义，结果都会落在元数据存根上。SharpLsp 会跨越语言边界解析定义，把请求路由到拥有目标文件的 sidecar，并返回真实的 F# 源位置。这件事此前从未在任何开源 LSP 实现中做到过。

完整路线图见 [技术规格](/docs/specs/sharplsp-spec.md)。代码在 [GitHub](https://github.com/Nimblesite/SharpLsp) 上。

SharpLsp 之所以存在，是因为 .NET 开发者应该拥有世界级工具，而不该被专有许可证、供应商锁定或单一编辑器绑定所限制。社区已经构建了十多年权宜之计。我们不再构建权宜之计了。来一起构建真正的东西。
