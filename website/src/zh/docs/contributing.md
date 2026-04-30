---
layout: layouts/docs.njk
title: 贡献
lang: zh
eleventyNavigation:
  key: 贡献（中文）
  order: 13
---

# 贡献与从源码构建

本页面面向希望从源码构建 SharpLsp 的贡献者。如果你只想使用 SharpLsp，请安装 VS Code 扩展——它已捆绑提供所有必需组件。

## 前置要求

- **Rust**（最新稳定版）— 通过 [rustup](https://rustup.rs) 安装
- **.NET 10.0 SDK** — [下载](https://dotnet.microsoft.com/download)
- **Node 20** — 用于 VS Code 扩展

## 推荐方式：开发容器

最快捷的方式是使用项目随附的开发容器。它已预配置 Rust、.NET 10 SDK、Node 20 以及所有必需工具。

1. 安装 [Docker](https://www.docker.com/) 和 [Dev Containers 扩展](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
2. 在 VS Code 中打开仓库
3. 出现提示时点击**在容器中重新打开**

## 手动设置

```sh
# 构建 Rust LSP 宿主
cargo build

# 运行 clippy lint 检查
cargo clippy

# 运行测试
cargo test

# 构建 VS Code 扩展 VSIX
cd editors/vscode && npm install && npm run compile
```

## 仓库结构

```
sharplsp/
├── src/                  # Rust LSP 宿主
├── sidecars/
│   ├── SharpLsp.Sidecar.FSharp/   # F# sidecar（FSharp.Compiler.Service）
│   ├── SharpLsp.Sidecar.CSharp/   # C# sidecar（Roslyn）
│   └── SharpLsp.Sidecar.Common/   # 共享 sidecar 代码
├── editors/
│   ├── vscode/           # VS Code 扩展（TypeScript）
│   └── zed/              # Zed 扩展（Rust → wasm32-wasip1）
├── docs/                 # 规范与实现计划
├── tests/                # 端到端测试
└── website/              # 本网站
```

## 架构

三层架构：

- **第一层 — Rust LSP 宿主**：LSP 连接（基于 stdio 的 JSON-RPC）、VFS、tree-sitter 增量解析、请求路由、sidecar 生命周期
- **第二层 — C# Sidecar（Roslyn）**：MSBuildWorkspace、完整的 Roslyn API（代码补全、诊断、重构、格式化）
- **第三层 — F# Sidecar（FCS）**：FSharp.Compiler.Service、Fantomas、FSharpLint

IPC 通过命名管道（Windows）/ Unix 域套接字（Linux、macOS）使用 MessagePack。

请参阅[架构](/zh/docs/architecture/)以查看完整分解。

<p class="next-link"><a href="/zh/docs/architecture/">下一节：架构 <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span></a></p>
