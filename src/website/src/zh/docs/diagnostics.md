---
layout: layouts/docs.njk
title: 诊断
description: "SharpLsp 的 C# 与 F# 诊断：Roslyn 和 F# Compiler Service 针对未保存代码的错误、推送与拉取两种模式，以及未使用 open 和死代码分析器。"
lang: zh
---

<img src="/assets/screenshots/docs/diagnostics.webp" alt="问题面板：来自未保存编辑的 F# Compiler Service F# 类型错误和 Roslyn C# CS0029 错误" width="2400" height="1500">

# 诊断

SharpLsp 会报告 C# 和 F# 的编译器诊断。Roslyn 处理 C# 文件，F# Compiler Service 处理 F# 文件。每个 sidecar 都会分析编辑器中的当前缓冲区，因此尚未保存的更改也包含在内。

{% video "diagnostics" %}

## 传递模型

包括 VS Code 在内的现代客户端使用 LSP 3.17 拉取诊断：

- **文档拉取：** `textDocument/diagnostic` 获取当前文件的诊断。
- **工作区拉取：** `workspace/diagnostic` 包含已加载的 F# 和 C# 源文件，包括尚未打开的文件。解决方案范围分析默认启用；VS Code 扩展请求这些结果并显示在问题面板中。
- **推送回退：** 不支持拉取的客户端接收 `textDocument/publishDiagnostics`。每个客户端只使用一种传递模型，因此同一错误不会重复显示。

未保存的编辑、关闭文件在磁盘上的更改以及项目输入的变化都会刷新诊断。启用解决方案范围分析时，关闭文件仍会保留真实错误。禁用后会清除已关闭文件的结果，同时保留打开文件的诊断。

对使用推送回退的客户端，版本代次门控可防止较早的请求覆盖较新的结果。

## 诊断来源

| 语言 | 当前可用的来源 |
|---|---|
| F# | FCS 编译器诊断，以及 `SLSPF0101` 死代码、`SLSPF0102` 未使用的 `open` 和 `SLSPF0103` 冗余限定符 |
| C# | Roslyn 编译器诊断、项目的 SDK/NuGet Roslyn 分析器，以及 SharpLsp 死代码诊断（`SLSPC0101`） |

Roslyn 分析器遵循项目求值后的分析器引用、`.editorconfig`、`NoWarn` 和源代码抑制规则。仅添加 `.editorconfig` 规则不会加载项目未引用的分析器程序集。`diagnostics.analyzers_enabled` 控制分析器诊断，编译器错误仍会显示。目前尚不提供 FSharpLint 和 FSharp.Analyzers.SDK 集成。

## 配置

```toml
[diagnostics]
# 解决方案诊断包含尚未打开的 F# 和 C# 源文件
solution_wide_analysis = true

# 项目名称或相对于所选解决方案的路径；空列表表示所有项目
project_filter = []

# 启用分析器诊断，同时保留编译器错误
analyzers_enabled = true

# 最低严重级别：error、warning、info 或 hint
min_severity = "hint"

# 按严重级别筛选后限制每个文件的数量；0 表示不限制
max_per_file = 0

# 合并源文件或项目更改后的刷新请求（毫秒）
refresh_debounce_ms = 2000

[analyzers]
# SharpLsp 的 C# 和 F# 死代码分析器
dead_code = true

# 将仓库视为完整的使用边界
monorepo = false
```

项目筛选器适用于两种语言的工作区结果。直接发送的 `textDocument/diagnostic` 请求不受筛选。筛选器也接受完整的本机项目路径，glob 模式使用正斜杠。

在普通模式下，无法访问的私有/内部死代码以警告报告，公共符号则被视为可能供外部调用的 API。在 monorepo 模式下，未使用的公共符号也会被报告，并使用错误级别。

## 严重级别映射

| 编译器/分析器严重级别 | LSP 严重级别 |
|---|---|
| Error | 1 — 错误 |
| Warning | 2 — 警告 |
| Info | 3 — 信息 |
| Hidden / hint | 4 — 提示 |

`server.debounce_ms` 字段会被接受以确保配置兼容性，但目前尚未应用。诊断请求会立即启动，过时的结果则由版本代次门控抑制。
