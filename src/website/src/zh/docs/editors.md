---
layout: layouts/docs.njk
title: 编辑器配置
description: "在 VS Code、Cursor、Windsurf 和 VSCodium 中设置 SharpLsp，并了解 Rider 插件、独立服务器以及 Zed、Neovim 等其他 LSP 客户端的现状。"
lang: zh
eleventyNavigation:
  key: 编辑器配置（中文）
  order: 3
---

# 编辑器配置

<img src="/assets/screenshots/docs/editors.webp" alt="按 SharpLsp 过滤的 VS Code 命令面板，列出了扩展的 NuGet、生成、F# Interactive、调试和性能分析器命令" width="2400" height="1500">

SharpLsp 在协议层面与编辑器无关。目前受支持且已打包的客户端是 VS Code；其他集成仍在开发中。

{% video "editor-setup" %}

## VS Code

从 [VS Code Marketplace 安装 SharpLsp](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp)；在 Cursor、Windsurf 和 VSCodium 中则从 [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) 安装。VSIX 包含 Rust 宿主以及 C# 和 F# sidecar，因此无需单独安装 SharpLsp。

激活时，扩展会：

1. 查找兼容的 .NET 10 SDK，或通过 Microsoft 的 .NET Install Tool 获取一个；
2. 确定适用于当前平台的内置二进制文件；
3. 启动语言客户端和 sidecar；
4. 在工作区中发现解决方案或项目。

扩展还提供解决方案资源管理器、NuGet 浏览器、性能分析器、调试器集成、测试 CodeLens、F# Interactive 命令、构建命令以及状态和输出视图。

### 工作区信任

在不受信任的工作区中，SharpLsp 只运行自身内置的二进制文件。任何可能选择可执行文件或注入参数的工作区值（例如 `sharplsp.lspPath`、sidecar 路径、额外服务器参数、FSI 参数和调试适配器路径）都会被忽略，直到你信任该工作区。

### 自定义开发二进制文件

在受信任的工作区中，可以通过 `sharplsp.lspPath`、`sharplsp.csharpSidecarPath` 和 `sharplsp.fsharpSidecarPath` 设置让扩展使用本地开发版本。将这些设置留空即可使用发行版内置的二进制文件。

## Zed

在 Zed 中，SharpLsp 通过本仓库中的开发扩展运行，与 Zed 自己的 C# 和 F# 扩展并用。[在 Zed 中使用 SharpLsp](/zh/docs/zed/) 介绍了如何安装、如何选择 SharpLsp 而不是其他 C# 和 F# 服务器、设置以及故障排除。

## 其他 LSP 客户端

通用编辑器可以通过标准输入输出使用 LSP 3.17 与宿主通信，每次[发布](https://github.com/Nimblesite/SharpLsp/releases)都会提供按平台区分的独立服务器归档（宿主与两个 sidecar 放在一起），以及启动它的 Rider 插件（`sharplsp-rider.zip`）。Neovim、Helix 和 Emacs 的打包集成属于规划内容，并非当前发布的使用界面。

要了解如何从代码库构建，请参阅[参与贡献](/zh/docs/contributing/)。
