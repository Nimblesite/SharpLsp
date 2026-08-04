---
layout: layouts/docs.njk
title: 编辑器配置
lang: zh
eleventyNavigation:
  key: 编辑器配置（中文）
  order: 3
---

# 编辑器配置

![SharpLsp 编辑器支持](/assets/screenshots/vscode-editors-page.png)

SharpLsp 在协议层面与编辑器无关。目前受支持且已打包的客户端是 VS Code；其他集成仍在开发中。

## VS Code

从 [VS Code Marketplace 安装 SharpLsp](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp)。VSIX 包含 Rust 宿主以及 C# 和 F# sidecar，因此无需单独安装 SharpLsp。

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

## 其他 LSP 客户端

通用编辑器可以通过标准输入输出使用 LSP 3.17 与宿主通信，但 SharpLsp 尚未提供受支持的独立安装流程，来为这些客户端部署宿主和两个 sidecar。Zed、Neovim、Rider、Helix 和 Emacs 集成属于规划内容，并非当前发布的使用界面。

要了解如何从代码库构建，请参阅[参与贡献](/zh/docs/contributing/)。
