---
layout: layouts/blog.njk
title: "没有幽灵错误的拉取式诊断"
description: "SharpLsp 使用 LSP 3.17 拉取式诊断和工作区刷新，让 C# 错误随 Roslyn 状态收敛，而不是在解决方案加载期间推送过期误报。"
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
excerpt: "只有开发者能信任诊断，诊断才有用。SharpLsp 的诊断设计从这里开始。"
---

诊断是开发者反馈循环。如果 Problems 面板会撒谎，人们就会停止相信它。SharpLsp 的诊断架构围绕这个约束构建：报告编译器真正知道的内容，在工作区变化时积极失效，并避免假装一个半加载的解决方案已经完整。

SharpLsp 围绕 [LSP 3.17 诊断模型](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_diagnostic) 实现诊断：编辑器拉取诊断报告，而服务器在缓存结果应该被丢弃时发送工作区刷新通知。

## 为什么加载期间推送诊断有风险

大型 .NET 解决方案不会一次性变成语义完整状态。工作区可能还在还原 NuGet 包。Source generator 可能还没有产出内容。项目引用可能仍在解析。Roslyn 也许已经有足够状态解析某个文件，但还没有足够状态为整个解决方案给出最终语义答案。

如果语言服务器过早推送诊断，用户就可能看到错误的 `CS0246` 或 `CS0234`，而这些类型会在工作区完成加载后正确解析。编辑器没有失败。是服务器断言得太早。

SharpLsp 避免这种失败模式。它不需要在工作区加载期间的某个瞬间主动声称每个文件都有错误。

## 拉取 + 刷新的循环

SharpLsp 目标中的诊断流程是：

1. 编辑器打开解决方案或文档。
2. Rust LSP 宿主跟踪文档状态，并把语义请求路由到 sidecar。
3. C# sidecar 使用 Roslyn 工作区状态回答文档或工作区诊断拉取。
4. 每个结果都带有基于项目、文档和全局工作区状态的身份。
5. 当工作区状态变化时，sidecar 通知宿主。
6. 宿主发送 `workspace/diagnostic/refresh`。
7. 编辑器在新状态下再次拉取。

这样编辑器获得的是可缓存协议，而不是过期权威。服务器可以在结果身份仍然匹配时说“未变化”，也可以在解决方案状态推进后强制重新拉取。

## NuGet Restore Gate

NuGet restore 是 .NET 工具中最大的幽灵诊断来源之一。缺失的 assets 会让完全有效的代码看起来坏掉。SharpLsp 的诊断规格把 restore 状态视为正确性的一部分，而不是后台便利功能。

在为解决方案创建 Roslyn 工作区之前，SharpLsp 的设计包含针对过期 `project.assets.json` 状态的 restore gate。目标不是隐藏真实编译器错误，而是防止诊断基于一个根本不可能知道包引用的工作区计算出来。

## 解决方案级诊断仍然重要

避免误报并不意味着只诊断打开的文件。SharpLsp 面向解决方案级诊断设计，因为构建失败通常跨越文件和项目边界。

关键区别在于时机和失效：

- 打开文件诊断直接回答编辑器询问的内容。
- 工作区诊断让编辑器可以显示当前未打开文档中的错误。
- 刷新通知告诉编辑器此前的答案什么时候不再可信。

这比一次性急切扫描更有纪律。它也更适合大型解决方案，因为未变化的结果身份可以让编辑器和服务器跳过重复工作。

## Alpha 阶段用户应该期待什么

SharpLsp 仍然是 alpha 软件。VS Code 扩展是主要验证场，诊断路径正在围绕真实 Roslyn 行为收紧，而不是围绕模拟项目图。

目标很直接：当 SharpLsp 显示 C# 诊断时，它应该反映 Roslyn 对当前工作区的理解。当 Roslyn 的理解变化时，SharpLsp 应该让编辑器重新询问。一个 .NET LSP 就是这样赢得信任的。
