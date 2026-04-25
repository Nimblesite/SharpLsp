---
layout: layouts/docs.njk
title: 快速入门
lang: zh
eleventyNavigation:
  key: 快速入门（中文）
  order: 1
---

# 快速入门

Forge 是一个使用 Rust 构建的开源 .NET 语言服务器协议（LSP）实现。它为支持 LSP 的任何编辑器提供完整的 C# 和 F# 语言支持。

## 前置要求

- [Rust](https://rustup.rs/)（最新稳定版）
- [.NET 9.0 SDK](https://dotnet.microsoft.com/download/dotnet/9.0) 或更高版本
- 支持 LSP 的编辑器（VS Code、Neovim、Emacs、Helix、Zed 等）

## 安装

### 从源码构建

```bash
git clone https://github.com/MelbourneDeveloper/forge.git
cd forge
cargo build --release
```

### VS Code 扩展

从 VS Code 应用商店安装 Forge 扩展，或直接安装 `.vsix` 文件。

## 架构概览

Forge 采用三层架构：

| 层级 | 组件 | 职责 |
|------|-----------|------|
| **1** | Rust LSP 宿主 | LSP 连接、VFS、tree-sitter 解析、salsa 缓存 |
| **2** | C# Sidecar | 由 Roslyn 驱动的代码补全、诊断、重构 |
| **3** | F# Sidecar | FSharp.Compiler.Service、FSharpLint 诊断 |

Rust 宿主处理所有 LSP 通信和语法级操作。语义操作通过 IPC 委托给相应的 .NET sidecar 进程。

## 下一步

- [架构](/zh/docs/architecture/) — 深入了解三层设计
- [编辑器配置](/zh/docs/editors/) — 配置你的编辑器以使用 Forge
