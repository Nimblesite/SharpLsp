---
layout: layouts/docs.njk
title: 跳转到定义
lang: zh
eleventyExcludeFromCollections: true
---

![VS Code 中的跳转到定义](/assets/screenshots/vscode-go-to-definition-page.png)

# 导航

SharpLsp 为 C# 和 F# 实现了 LSP 导航请求系列。C# 查询通过 Roslyn 搜索已加载的解决方案；F# 查询通过 FCS 搜索已加载的 F# 项目。

## 方法

| LSP 方法 | 结果 |
|---|---|
| `textDocument/definition` | 符号的源代码声明 |
| `textDocument/typeDefinition` | 符号类型的声明 |
| `textDocument/declaration` | 与实现位置不同时，返回基类或接口声明 |
| `textDocument/implementation` | C#：具体实现或重写；F#：目前返回选中符号自身的声明 |
| `textDocument/references` | 已加载解决方案或项目中的符号使用位置 |
| `textDocument/documentHighlight` | 当前文档中的使用位置 |

SharpLsp 不会添加导航快捷键。请使用编辑器的标准 LSP 快捷键。

重命名和调用层级使用 sidecar 的语义符号信息，并各自使用独立的 LSP 方法。C# 文档符号和工作区符号由 Rust 宿主与 tree-sitter 提供；F# 工作区符号则通过 FCS 提供。

## 源码范围

- **C#：** 定义、实现、引用和重命名使用由 `MSBuildWorkspace` 加载的 Roslyn 解决方案。
- **F#：** 导航和重命名使用 FCS 项目检查。在当前已加载的 F# 项目中，引用和重命名均为项目范围。实现查找仍为部分支持，目前会回退到选中符号的声明。
- **未保存的文件：** 执行查询前，两个 sidecar 都会收到编辑器缓冲区中的当前内容。

多项目 F# 状态和完整的跨语言层级关系仍在开发中。

## 元数据即源码

当符号来自 BCL 或引用程序集时，两个 sidecar 都可以使用共享的 ICSharpCode.Decompiler 集成创建只读源码文件，并导航到相应声明。这适用于许多未加载源码文档的框架和 NuGet 符号。

## 失败行为

如果当前位置无法解析为符号，或所需的 sidecar 不可用，导航会返回空位置。C# 可以通过 tree-sitter 对注释和字符串进行预校验；由于宿主没有 F# tree-sitter 语法，F# 目前依赖 FCS。
