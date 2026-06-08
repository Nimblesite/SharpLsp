---
layout: layouts/docs.njk
title: 编辑器配置
lang: zh
eleventyNavigation:
  key: 编辑器配置（中文）
  order: 3
---

# 编辑器配置

![VS Code 中的 SharpLsp 编辑器支持](/assets/screenshots/vscode-editors-page.png)

SharpLsp 在 LSP 层面以编辑器无关为目标。VS Code 扩展是当前主要支持的界面。Neovim 和 Zed 支持即将推出。

**前提条件：** 安装 [.NET 10.0 SDK](https://dotnet.microsoft.com/download)，并确保 `dotnet` 在 PATH 中。

## VS Code

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) 安装 SharpLsp 扩展。扩展在 VSIX 内附带 `sharplsp` 二进制文件和两个 sidecar——无需 Rust 工具链或单独的二进制安装。

扩展会自动管理 `sharplsp` 服务器生命周期，并提供解决方案资源管理器、性能分析器、NuGet 浏览器、测试视图和编辑器状态集成。无需额外配置。

## Neovim

即将推出。

## Zed

即将推出。
