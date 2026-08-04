---
layout: layouts/docs.njk
title: 参与贡献
lang: zh
eleventyNavigation:
  key: 参与贡献（中文）
  order: 13
---

# 参与贡献与从源码构建

本页面面向贡献者。VS Code 用户通常应安装 Marketplace 扩展，其中已包含宿主和 sidecar。

## 先决条件

- 通过 [rustup](https://rustup.rs) 安装的 Rust stable
- .NET 10 SDK（代码库固定使用 10.0.203，并允许兼容的前向滚动）
- Node.js 20 或更高版本
- Git

部分性能分析器测试还需要全局工具 `dotnet-trace`、`dotnet-counters` 和 `dotnet-dump`。

## 开发容器

随附的开发容器提供项目使用的 Rust、.NET、Node 和测试工具。在 VS Code 中打开代码库，然后选择 **Dev Containers: Reopen in Container**。

## 代码库布局

```text
SharpLsp/
├── Cargo.toml                    # 根 Rust 工作区清单
├── src/
│   ├── sharplsp/                 # Rust 宿主、构建脚本和 Rust 端到端测试
│   ├── sidecars/                 # C#、F# 和共享的 .NET sidecar/测试
│   ├── editors/
│   │   ├── vscode/               # VS Code 扩展
│   │   ├── zed/                  # Zed 集成源码
│   │   └── rider/                # Rider 集成源码
│   ├── examples/                 # 示例解决方案和配置
│   ├── fixtures/                 # 测试和真实场景固定样例
│   └── website/                  # Eleventy 文档网站
├── docs/                         # 技术规范和计划
└── tools/                        # 构建、打包、覆盖率和共享 make 辅助工具
```

## 构建与测试

请从代码库根目录运行命令。

```sh
# Rust 宿主
cargo build
cargo clippy --all-targets --all-features
cargo test

# .NET sidecar
dotnet test src/sidecars/SharpLsp.Sidecars.sln

# VS Code 扩展
npm --prefix src/editors/vscode ci
npm --prefix src/editors/vscode run lint
npm --prefix src/editors/vscode run package

# 网站
npm --prefix src/website ci
npm --prefix src/website run build
npm --prefix src/website test
```

扩展的端到端测试套件会部署真实的 SharpLsp 二进制文件，并启动 VS Code 测试宿主。它比 TypeScript 检查更为繁重；请以代码库中的 Make 目标和 CI 工作流作为完整测试矩阵的准确信息来源。

## 架构

SharpLsp 有三个运行时层级：

- Rust LSP 宿主；
- Roslyn C# sidecar；
- FCS F# sidecar。

IPC 在 Windows 上通过命名管道传输 MessagePack，在 Linux/macOS 上通过 Unix 域套接字传输。更改跨层级行为之前，请阅读[架构](/zh/docs/architecture/)。

## 文档来源

面向公众的网站文档位于 `src/website/src/docs`，对应的日语和简体中文版本分别位于 `src/website/src/ja/docs` 和 `src/website/src/zh/docs`。

技术行为规范位于 `docs/specs`；实现计划位于 `docs/plans`。每当用户可见的行为发生变化时，请同时更新公开文档和两种翻译。

<p class="next-link"><a href="/zh/docs/architecture/">架构 <span aria-hidden="true">→</span></a></p>
