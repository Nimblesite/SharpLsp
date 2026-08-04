---
layout: layouts/docs.njk
title: F# 语言支持
lang: zh
eleventyExcludeFromCollections: true
---

# F# 语言支持

F# 在 SharpLsp 中是**一等公民**。Rust LSP 主机会将 F# 语义请求路由到一个长期运行的 .NET 10 sidecar；该 sidecar 基于 [F# Compiler Service (FCS)](https://fsharp.github.io/fsharp-compiler-docs/) 构建。SharpLsp 还集成了 Fantomas，并提供了自己的 FCS 分析器；但下文只把已经由主机完成路由并向客户端公布的功能列为可用。

[FsAutoComplete (FSAC)](https://ionide.io/Tools/fsac.html) 是 Ionide 背后的引擎，也是 SharpLsp 的功能对齐目标。SharpLsp 目前已经覆盖了相当广泛的功能，但**尚未**宣称与 FSAC 完全一致。

## 功能状态

| 功能 | 状态 | 当前行为 |
|---|---|---|
| 补全 | 部分支持 | 成员和当前作用域内的符号可用；尚不支持未打开命名空间的建议和自动插入 `open` |
| 悬停信息 | 支持 | 根据实时缓冲区提供 FCS 签名和 XML 文档 |
| 签名帮助 | 支持 | 支持重载和活动参数选择 |
| 定义、类型定义、声明 | 支持 | 支持源码和元数据导航 |
| 实现 | 部分支持 | 目前返回选中符号自身的声明，而不是具体实现或重写 |
| 查找引用 | 支持 | 在已加载的 F# 项目内进行项目级搜索 |
| 文档高亮 | 支持 | 高亮当前文档中的引用 |
| 重命名 | 支持 | 支持预检和项目级多文档编辑 |
| 文档符号／大纲 | 支持 | 提供带嵌套层级的 FCS 导航项 |
| 工作区符号 | 支持 | 通过 FCS 查询 F# 文档 |
| 代码操作／快速修复 | 支持 | 提供下文列出的编译器驱动和生成式操作 |
| Code Lens | 支持 | 显示顶层定义的引用计数 |
| 内联提示 | 支持 | 提供类型、参数名和管道类型提示 |
| 语义令牌 | 支持 | 支持完整、范围和增量响应 |
| 诊断 | 支持 | 提供 FCS 编译器诊断和 SharpLsp 分析器诊断 |
| 调用层次结构 | 支持 | 支持传入和传出调用 |
| 类型层次结构 | 部分支持 | sidecar 和主机处理程序已经存在；客户端能力仍未公布 |
| 格式化（Fantomas） | 未开放 | sidecar 已实现，但主机有意不公布也不路由该功能 |
| 折叠／选择范围 | 尚未支持 | Rust 主机尚未包含 F# tree-sitter 语法 |
| F# Interactive | 支持 | 提供发送代码、启动 FSI 和生成签名的 VS Code 命令 |

## IntelliSense

### 补全

FCS 的 `GetDeclarationListInfo` 提供补全候选项。`.` 后的成员补全和当前作用域内的符号现在都可用。SharpLsp 尚未提供 FSAC 的外部自动补全实体索引，因此无法给出未打开命名空间中的所有符号，也不能在解析补全项时自动添加相应的 `open`。

### 悬停信息和签名帮助

悬停信息会以 Markdown 呈现 F# 签名和文档。签名帮助使用 FCS 的方法组信息显示重载和活动参数。由于 `didOpen` 和 `didChange` 文本会同步到 F# sidecar，这两项功能都能处理编辑器中尚未保存的内容。

### 内联提示

SharpLsp 提供：

- 绑定的推断类型提示；
- 调用位置的参数名提示；
- 对通过 `|>` 传递的值显示管道类型提示。

VS Code 设置 `sharplsp.inlayHints.typeInference`、`sharplsp.inlayHints.parameterNames` 和 `sharplsp.inlayHints.pipelineTypes` 已公开，但生产扩展目前尚未应用这些设置。因此，无论这些值如何，所有已生成的提示类别都可能显示。

## 导航和重命名

定义、类型定义、声明、引用、高亮和重命名都通过 FCS 符号用法解析。引用和重命名会扫描已加载的 F# 项目，并可返回跨多个文件的编辑。实现查找目前为部分支持，只会返回选中符号自身的声明，而不会查找具体实现或重写。来自 BCL 或 NuGet 包的元数据符号可以打开生成的只读反编译源码。

跨语言层次结构边以及多项目 F# 工作区状态仍不完整。

## 代码操作和快速修复

当上下文有效时，F# sidecar 目前会提供以下操作：

| 触发条件或上下文 | 操作 |
|---|---|
| `FS0039` 未解析名称 | 当 FCS 提供命名空间时，添加可解析该名称的 `open` 声明 |
| `FS1182` 未使用的值 | 为绑定名称添加 `_` 前缀 |
| `FS0020` 忽略了结果 | 添加 `|> ignore` |
| `FS0025` 模式匹配不完整 | 添加通配符分支 |
| `FS0026` 冗余分支 | 删除冗余模式 |
| `FS0001` 支持的类型不匹配 | 插入已知转换 |
| 可辨识联合匹配 | 生成缺失的联合分支 |
| 记录表达式 | 生成缺失的记录字段 |
| 接口实现 | 生成成员存根 |
| `SLSPF0102` | 删除未使用的 `open` |
| `SLSPF0103` | 简化冗余的限定名称 |

编译器拼写错误建议和 FSAC 的“添加 `new`”修复尚未实现。

## 诊断和分析器

FCS 编译器诊断会与 SharpLsp 自有分析器的结果合并：

| 分析器 | 代码 | 范围 |
|---|---|---|
| 未使用的符号／死代码 | `SLSPF0101` | 整个项目 |
| 未使用的 `open` | `SLSPF0102` | 当前文件 |
| 冗余限定符 | `SLSPF0103` | 当前文件 |

`[analyzers] dead_code = true` 会启用死代码分析。`monorepo = false` 时，不可达的私有／内部符号会报告为警告，公共符号则视为可能供外部调用的 API。`monorepo = true` 时，未使用的公共符号也会报告，并升级为错误。

FSharpLint 已作为依赖项存在，但尚未接入诊断管线。

## 格式化

SharpLsp 不会公布 LSP 格式化能力。F# sidecar 包含 Fantomas 文档和范围格式化代码，但主机目前有意将其隔离。在路由启用之前，请使用专门的 Fantomas 集成来格式化。

## F# Interactive

VS Code 扩展提供：

| 命令 | 操作 |
|---|---|
| `F# Interactive: Send Selection` | 执行当前选区 |
| `F# Interactive: Load File` | 发送活动文件 |
| `F# Interactive: Start New Session` | 启动或聚焦由终端承载的会话 |
| `F#: Generate Signature File (.fsi)` | 生成 `.fsi` 签名 |

FSI 使用扩展激活期间定位或安装的 .NET 10 SDK。额外参数来自受信任工作区的 VS Code 设置 `sharplsp.fsi.extraArgs`，不会从 `sharplsp.toml` 读取。

## 编辑器无关协议

SharpLsp 优先使用标准 LSP 方法来实现补全、悬停信息、导航、符号、诊断、Code Lens 和层次结构。目前受支持的客户端是 VS Code；其他编辑器集成仍在准备中。

## 当前功能差距

F# 目前的主要差距包括：

- 未打开命名空间的补全和自动 `open`；
- 由主机路由的 Fantomas 格式化；
- F# 折叠和选择范围；
- FSharpLint 诊断；
- 完整的 `.fsx` 语义一致性和 FSAC 文档端点；
- 多项目 F# 工作区和跨语言层次结构；
- 面向标准客户端的类型层次结构能力公布。

<p class="next-link"><a href="/zh/docs/diagnostics/">下一篇：诊断 <span aria-hidden="true">→</span></a></p>
