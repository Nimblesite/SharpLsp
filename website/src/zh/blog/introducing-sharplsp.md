---
layout: layouts/blog.njk
title: SharpLsp 介绍
lang: zh
date: 2026-03-20
author: SharpLsp 团队
image: /assets/images/blog/introducing-sharplsp-zh.png
imageAlt: 抽象语言服务器核心连接多个编辑器和开发工具节点
tags: posts
excerpt: 一个用 Rust 构建的开源 .NET LSP — 为每款编辑器带来一流的 C# 和 F# 支持。
---

# SharpLsp 介绍

我们正在构建 SharpLsp — 一个开源的、编辑器无关的 C# 和 F# 语言服务器。

## 问题所在

.NET 开发者长期被锁定在专有工具中。Visual Studio 仅限 Windows 且体量庞大。Rider 需要许可证。C# Dev Kit 是闭源的，且仅限于 VS Code。如果你使用 Neovim、Helix、Emacs 或 Zed — 你是二等公民。

## 解决方案

SharpLsp 是一个单一的 LSP 服务器，为每款编辑器提供完整的 .NET 开发体验。用 Rust 构建以追求速度，由 Roslyn 和 FSharp.Compiler.Service 驱动以确保准确性。

### 关键设计决策

- **Rust 宿主**，用于亚毫秒级 tree-sitter 解析和增量计算
- **.NET sidecar**，用于完整的语义分析 — 无需重新实现，无需近似
- **F# 作为一流公民** — 不是事后添加的附属品
- **零专有依赖** — MIT 许可证，欢迎贡献

## 性能目标

我们正在追求积极的延迟目标：

- 代码补全：p50 <100ms
- 跳转到定义：p50 <100ms
- 诊断刷新：按键后 <500ms
- 冷启动：首次 LSP 响应 <3s

## 参与进来

SharpLsp 是开源的。查看 [GitHub 仓库](https://github.com/Nimblesite/SharpLsp)，加入我们，共同构建开发者应得的 .NET 工具链。
