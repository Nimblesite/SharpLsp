---
layout: layouts/blog.njk
title: "VS Code 中的 Blazor 与 Razor：为 .razor 文件提供 C# 工具"
description: "SharpLsp 现在可以在 VS Code 中编辑 Blazor 组件、Razor Pages 和 MVC 视图：在 .razor 与 .cshtml 文件中提供 C# 悬停、补全、诊断、转到定义和重命名。"
lang: zh
date: 2026-10-20
author: SharpLsp 团队
image: /assets/images/blog/blazor-razor-vs-code.png
imageAlt: "VS Code 中 Blazor 组件标记内的 C# 悬停，旁边是 Blazor and Razor in VS Code 的标题"
tags:
  - posts
  - blazor
  - razor
  - csharp
  - dotnet-lsp
category: announcement
excerpt: "Blazor 组件、Razor Pages 和 MVC 视图现在与你的 C# 文件使用同一个 Roslyn 引擎：在标记内部提供悬停、补全、诊断、转到定义、引用和重命名。"
---

SharpLsp 现在理解 Razor。Blazor 组件（`.razor` 文件），以及 Razor Pages 和 MVC 视图（`.cshtml` 文件），与你的其余 C# 代码使用同一个 Roslyn 引擎。在标记内部，你可以使用悬停、补全、诊断、转到定义、引用和重命名。这项支持现已进入 `main` 分支，并将在下一个版本中发布。

下面是一个小型 Blazor Web App 上的效果：

{% video "blazor" %}

## 什么是 Blazor？一分钟了解 Blazor 与 Razor

这两个名字描述的是不同的层次，所以很容易混淆。

- **Razor** 是语法。它把 HTML 与 C# 混合在一起：一个 `@` 表达式、一个 `@if` 或 `@foreach` 块、一个 `@code` 块。Microsoft 的 [Razor 语法参考](https://learn.microsoft.com/zh-cn/aspnet/core/mvc/views/razor?view=aspnetcore-10.0)涵盖了全部内容。
- **ASP.NET Core Razor Pages 和 MVC 视图**是服务器为每个请求呈现的 `.cshtml` 文件。请阅读 [ASP.NET Core 中的 Razor Pages](https://learn.microsoft.com/zh-cn/aspnet/core/razor-pages/?view=aspnetcore-10.0)和 [ASP.NET Core MVC 中的视图](https://learn.microsoft.com/zh-cn/aspnet/core/mvc/views/overview?view=aspnetcore-10.0)。
- **Blazor** 是组件框架。[Razor 组件](https://learn.microsoft.com/zh-cn/aspnet/core/blazor/components/?view=aspnetcore-10.0)就是一个 `.razor` 文件。Blazor Web App 是 .NET 8 起的 `dotnet new blazor` 模板，它在服务器上或在浏览器中的 WebAssembly 上运行组件。每个组件选择自己的[呈现模式](https://learn.microsoft.com/zh-cn/aspnet/core/blazor/components/render-modes?view=aspnetcore-10.0)：静态服务器呈现、`InteractiveServer`、`InteractiveWebAssembly` 或 `InteractiveAuto`。

在这三者之下是一个 Razor 编译器，它把每个 Razor 文件转换成 C#。这就是为什么 SharpLsp 中的一套实现就能同时服务 Blazor Server、Blazor WebAssembly、Razor Pages 和 MVC。

## 在 .razor 文件中你能得到什么

下面的一切都展示在视频演示的 `Basket.razor` 页面上，每一项都有自动化测试覆盖。

- **悬停。** 悬停 `@Total()`，Roslyn 会显示 `Basket.Total()` 的签名及其 XML 摘要。在布局中悬停 `@Body`，你会看到它所呈现的 `LayoutComponentBase.Body` 属性。
- **补全。** 在 `@` 表达式和 `@code` 块中提供 Roslyn 的成员补全。每次编辑都落在 `.razor` 文件里，补全添加的 `using` 会变成一行 `@using`。
- **诊断。** C# 的错误会带着编译器代码，报告在导致它的那一行 Razor 上，并显示在编辑器和“问题”面板中。整个解决方案的扫描涵盖 Razor 文件。
- **转到定义。** 在 `@onclick="() => Add(product)"` 中的 `Add` 上按 F12 会跳到 `@code` 块。在 `Catalog.Products` 上按 F12 会打开 `Catalog.cs`。从 C# 一侧，在 `app.MapRazorComponents<App>()` 的 `App` 上按 F12 会打开 `App.razor`，而不是生成的类。
- **引用和高亮。** 显示 Razor 文件中的每一处使用，不包含编译器生成的隐藏的脚手架代码。
- **重命名。** 重命名 `@code` 字段，标记中的每一处使用都会跟着改变。
- **结构。** 多行元素和 `@code` 块可以折叠，大纲列出指令和元素，重命名开始标签会同时重命名其结束标签。
- 调用中的**签名帮助**，以及文件中 C# 的**语义高亮**。

围绕 C# 的标记仍然是 HTML。在 VS Code 中，SharpLsp 把元素和属性补全以及 HTML 悬停转发给 VS Code 自带的 HTML 语言服务。它发送的是文件中每个 C# 片段都被留空的 HTML 视图，因此 HTML 服务永远不会把 C# 误认为标记。

## 工作原理：Razor 编译器是唯一的事实来源

构建 Razor 工具时，一个诱人的做法是写一个 Razor 解析器。SharpLsp 没有这样做。Razor 的语义属于 Razor 编译器，任何第二套解析器都会在每个版本中与它偏离。

自 .NET 6 起，[Razor 编译器就是一个 C# 源生成器](https://learn.microsoft.com/zh-cn/aspnet/core/release-notes/aspnetcore-6.0?view=aspnetcore-10.0#razor-compiler-updated-to-use-source-generators)。它随 .NET SDK 一起提供，C# sidecar 的设计时构建会像 `dotnet build` 一样运行它。生成器把每个 Razor 文件转换成一个 C# 类。每个 C# 片段都被原样复制进该类，位于一个指回 Razor 文本的[增强 `#line` 指令](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-10.0/enhanced-line-directives.md)之中。

SharpLsp 根据这些指令建立双向映射：

1. Razor 位置上的请求会映射到生成的 C# 中相同的字符。
2. Roslyn 在那里作答，与处理 `.cs` 文件时完全相同。
3. 答案中的每个位置都映射回 Razor 文件。

映射从不盲目相信指令。Roslyn 会把每个已映射范围的结束位置报告为片段末尾再多一个字符，因此 SharpLsp 通过逐字符比较 Razor 文本和生成的文本，来测量每个片段。生成器自己写出的代码（例如呈现标记的 `__builder` 调用）中的位置没有对应的 Razor 文本，永远不会传到你这里。

由于生成器来自编译器本身，它映射的每个构造中的 C# 都得到同样的处理。这包括 `@bind` 值、事件处理程序、泛型组件和 `@code` 块。负责折叠、大纲、链接编辑和 HTML 视图的标记一侧，来自编译器公开的[中间表示](https://github.com/dotnet/razor)，而不是重新实现。

## 在构建过程中发现的问题

在一个全新的 `dotnet new blazor` 应用上运行真实宿主时，发现了一个误报：`_Imports.razor` 中的每个 `@using` 都被淡显为不必要。Roslyn 只能看到每个文件自己生成的 C#，因此它无法看到导入文件的 using 是服务于它旁边和下方的组件的。当组件自身的 using 只被其标记需要时，也存在同样的问题。现在 Razor 文件不再报告不必要的 using，而 C# 文件（包括代码隐藏）仍然会报告。

第二个发现与 SDK 版本有关。Razor 生成器来自构建你的项目的 SDK，也就是已安装的最新版本，除非 `global.json` 固定了另一个版本。SDK 10.0.401 的生成器需要比 SharpLsp 捆绑的 Roslyn 更新的版本，因此它的 Razor 文件得不到任何 C# 功能。[Issue #399](https://github.com/Nimblesite/SharpLsp/issues/399) 追踪这项修复。在修复落地之前，请按照 [Blazor 与 Razor 文档](/zh/docs/blazor/)中的说明，在 `global.json` 中固定 SDK 10.0.303。

## .NET 10 上的 Blazor：Server、WebAssembly 和 Razor 类库

SharpLsp 读取你的解决方案中已有的项目。它们都通过 `Microsoft.NET.Sdk.Web`、`Microsoft.NET.Sdk.BlazorWebAssembly` 或 `Microsoft.NET.Sdk.Razor` 以相同的方式加载：

- 带有 Blazor Server 或 Blazor WebAssembly 交互性的 Blazor Web App；
- 独立的 Blazor WebAssembly 应用；
- Razor Pages 或 MVC 应用；
- 由共享组件组成的 [Razor 类库](https://learn.microsoft.com/zh-cn/aspnet/core/razor-pages/ui-class?view=aspnetcore-10.0)。

在 [.NET 10](https://devblogs.microsoft.com/dotnet/announcing-dotnet-10/) SDK 上的 ASP.NET Core 10 已经过验证，包括一个全新的 `dotnet new blazor` 应用。net8.0 和 net9.0 上的项目通过同一个源生成器编译 Razor，因此应该可以工作，但我们还没有验证它们。早于 .NET 6 的项目在不使用源生成器的情况下编译 Razor，因此不受支持，.NET Framework 的 MVC 5 和 Web Forms 同样不受支持。

## 接下来

这个版本涵盖 Razor 文件中的 C#。接下来是标记本身，在 [issue #397](https://github.com/Nimblesite/SharpLsp/issues/397) 中追踪：

- 组件标签、组件参数、`@bind-Value` 以及 `@onclick` 等指令属性上的悬停、定义、补全和引用；
- 编译器自带的 `RZ` 诊断，例如未知组件；
- Razor Pages 和 MVC 视图中的标记帮助程序，例如 `asp-for`；
- Blazor 前端背后的 F# 库：从 Razor 对 F# 类型的悬停、补全和定义，以及能触及 Razor 使用处的 F# 重命名；
- 格式化、提取组件等代码操作，以及热重载。

## 试一试

1. 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) 安装 SharpLsp，或在 Cursor、Windsurf 和 VSCodium 中从 [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) 安装。Razor 支持会在下一个版本中到来。
2. 用 `dotnet new blazor -o BlazorDemo` 创建一个 Blazor Web App，然后打开该文件夹。
3. 打开 `Components/Pages/Counter.razor`，悬停 `currentCount`。

[Blazor 与 Razor 文档](/zh/docs/blazor/)列出了每一项功能、支持的项目以及尚不支持的内容。

## 进一步阅读

- [ASP.NET Core Blazor](https://learn.microsoft.com/zh-cn/aspnet/core/blazor/?view=aspnetcore-10.0)与 [Blazor 托管模型](https://learn.microsoft.com/zh-cn/aspnet/core/blazor/hosting-models?view=aspnetcore-10.0)
- [Blazor 项目结构](https://learn.microsoft.com/zh-cn/aspnet/core/blazor/project-structure?view=aspnetcore-10.0)与 [Blazor 呈现模式](https://learn.microsoft.com/zh-cn/aspnet/core/blazor/components/render-modes?view=aspnetcore-10.0)
- [Blazor 数据绑定](https://learn.microsoft.com/zh-cn/aspnet/core/blazor/components/data-binding?view=aspnetcore-10.0)与[事件处理](https://learn.microsoft.com/zh-cn/aspnet/core/blazor/components/event-handling?view=aspnetcore-10.0)
- [.NET 10 中 ASP.NET Core 的新增功能](https://learn.microsoft.com/zh-cn/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0)
- [ASP.NET Core 中的标记帮助程序](https://learn.microsoft.com/zh-cn/aspnet/core/mvc/views/tag-helpers/intro?view=aspnetcore-10.0)
- [dotnet/razor 仓库](https://github.com/dotnet/razor)与 [dotnet/aspnetcore 仓库](https://github.com/dotnet/aspnetcore)
- [Embedded Programming Languages](https://code.visualstudio.com/api/language-extensions/embedded-languages)，VS Code 关于请求转发的指南
