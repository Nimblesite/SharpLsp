---
layout: layouts/docs.njk
title: 架构
lang: zh
eleventyNavigation:
  key: 架构（中文）
  order: 2
---

# 架构

![VS Code 中的 Forge 架构相关输出](/assets/screenshots/vscode-architecture-page.png)

Forge 基于三层架构构建，将快速语法操作与丰富语义分析的关注点分离。

## 第一层 — Rust LSP 宿主

宿主进程负责处理：

- **LSP 协议**：基于 stdio 的 JSON-RPC，目标是符合 LSP 3.17 行为
- **虚拟文件系统（VFS）**：带变更跟踪的内存文件状态
- **tree-sitter 解析**：当前优先覆盖 C# 语法路径；F# 支持仍在推进
- **salsa 缓存**：增量计算 — 仅重新处理变更的内容
- **请求路由**：快速语法请求留在 Rust 中，语义请求发送到 sidecar

## 第二层 — C# Sidecar（Roslyn）

提供以下功能的长运行 .NET 进程：

- 用于解决方案/项目加载的 MSBuildWorkspace
- Roslyn 支撑的 C# 功能：代码补全、诊断、代码操作、重构
- 用于跳转到反编译源码的 ICSharpCode.Decompiler
- 通过命名管道/Unix 域套接字的 MessagePack 序列化

## 第三层 — F# Sidecar（FCS）

用于 F# 支持的独立 .NET 进程：

- 用于类型检查和分析的 FSharpChecker
- 用于项目系统集成的 Ionide.ProjInfo
- 用于额外诊断的 FSharpLint

## IPC 协议

Rust 宿主与 .NET sidecar 之间的通信使用：

- **MessagePack** 二进制序列化（紧凑、快速）
- **命名管道**（Windows）或 **Unix 域套接字**（Linux、macOS）
- **4 字节小端序长度前缀**帧
- 目标：<500µs 往返开销

## 请求路由

| 类别 | 处理器 | 延迟目标 | 示例 |
|----------|---------|---------------|----------|
| 纯语法 | Rust (tree-sitter) | <5ms | documentSymbol、foldingRange |
| 语义 | Sidecar | <200ms | completion、hover、definition |
| 混合 | Rust + Sidecar | <100ms | semanticTokens |
| 缓存 | Rust (salsa) | <1ms | 重复请求，未变更文档 |
