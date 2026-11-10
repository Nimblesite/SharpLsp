---
layout: layouts/blog.njk
title: "VS Code 中的 C# 与 F# 快速修复"
description: "SharpLsp 为 C# 和 F# 提供明确的导入选项，并新增 C# 类型拆分到独立文件的重构。在 VS Code 灯泡菜单中修复缺失的命名空间。"
date: 2026-11-10
author: SharpLsp Team
image: /assets/images/blog/csharp-fsharp-quick-fixes-vs-code.webp
imageAlt: "象牙白的 F# 与 C# 方块由祖母绿连接线相连"
lang: zh
tags:
  - posts
  - csharp
  - fsharp
  - dotnet-lsp
category: announcement
excerpt: "选择命名空间导入、限定单处使用，或导入静态成员。SharpLsp 的快速修复现在会在应用之前说明将要进行的修改。"
---

{# Google Trends checked 2026-11-10, Worldwide, past 12 months, Web Search.
Comparison averages: C# 55, Visual Studio Code 20, F# 3, code refactoring 1 (normalized interest, not search counts).
https://trends.google.com/trends/explore?date=today%2012-m&q=Visual%20Studio%20Code,C%23,F%23,code%20refactoring
Title uses the broader relevant terms. No rising-trend claim.
Header generated with the built-in image tool: ivory F# and C# ceramic tiles joined by an emerald connector, off-white studio background, soft shadows, no extra text. #}

一个未解析的名称，可能需要命名空间、限定名称，或缺失的项目引用。SharpLsp 的 C# 和 F# 快速修复现在会明确告诉你它将进行哪一种修改。这些改进随 0.32 版本发布，并在 0.33 中继续可用。

在 Visual Studio Code 中，把光标放在错误上，按 **Ctrl+.**（macOS 上为 **Cmd+.**）。

## F# 导入

对于未解析的 `StringBuilder`，可以选择 `open System.Text`，或将该处使用限定为 `System.Text.StringBuilder`。对于 `Sqrt` 这类静态成员，菜单还可以提供 `open type System.Math`。

补全也会提供来自未打开命名空间的类型，并在接受时插入相应的 `open`。快速修复的标题会说明每次导入把什么带入作用域。如果缺少受支持的项目或包引用，还会有一个单独的操作，指明它将添加的引用。

## C# 导入

对于同样的 `StringBuilder` 错误，可以在三种修改之间选择。

- 添加 `using System.Text;`。
- 只导入该类型：`using StringBuilder = System.Text.StringBuilder;`。
- 将该处使用限定为 `System.Text.StringBuilder`。

静态成员也可以获得 `using static` 修复。如果某个操作无法应用，SharpLsp 会说明原因。

## 把 C# 类型移动到独立文件

把光标放在类型名上，选择 **Move type to Receipt.cs**，即可让 `Receipt` 拥有自己的文件。它的命名空间、导入、文档和特性都会随之迁移。

嵌套类型有一个单独的 **Move 'Inner' out of 'Outer' to Inner.cs** 操作，把它变成顶层类型，并更新整个解决方案中的引用。该操作会在提供移动之前检查冲突和不可访问的容器成员。

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) 安装 SharpLsp。[重构指南](/zh/docs/refactoring/)介绍了快捷键和受支持的操作。
