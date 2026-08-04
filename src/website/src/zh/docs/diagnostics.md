---
layout: layouts/docs.njk
title: 诊断
lang: zh
eleventyExcludeFromCollections: true
---

![VS Code 中的诊断](/assets/screenshots/vscode-diagnostics-page.png)

# 诊断

SharpLsp 会报告 C# 和 F# 的编译器诊断。Roslyn 处理 C# 文件，F# Compiler Service 处理 F# 文件。每个 sidecar 都会分析编辑器中的当前缓冲区，因此尚未保存的更改也包含在内。

## 传递模型

SharpLsp 同时支持两种 LSP 诊断模型：

- **推送：** 打开、更改或保存文档时启动后台分析，并发送 `textDocument/publishDiagnostics`。
- **文档拉取：** `textDocument/diagnostic` 获取当前文件的诊断。
- **C# 解决方案扫描：** 启用 `diagnostics.solution_wide_analysis` 后，C# sidecar 会在启动时扫描已加载的解决方案，并逐个文件发布结果。

SharpLsp 会声明标准 `workspace/diagnostic` 请求，但该请求目前返回空报告。工作区范围的结果改由 C# 启动扫描传递；F# 解决方案范围的拉取尚未实现。

版本代次门控可防止较早的后台请求覆盖较新的结果。关闭文档时会发布一个空集合，以清除该文档的诊断。

## 诊断来源

| 语言 | 当前可用的来源 |
|---|---|
| C# | Roslyn 编译器诊断和 SharpLsp 死代码诊断（`SLSPC0101`） |
| F# | FCS 编译器诊断，以及 `SLSPF0101` 死代码、`SLSPF0102` 未使用的 `open` 和 `SLSPF0103` 冗余限定符 |

第三方 Roslyn 分析器和 FSharpLint 目前尚未接入这条管线。因此，虽然 `diagnostics.analyzers_enabled` 字段可以被接受，但它还不是有效的开关。

## 配置

```toml
[diagnostics]
# 启动时扫描已加载的 C# 解决方案
solution_wide_analysis = true

# 将 C# 扫描限制到名称匹配的项目；空列表表示所有项目
project_filter = []

[analyzers]
# SharpLsp 的 C# 和 F# 死代码分析器
dead_code = true

# 将仓库视为完整的使用边界
monorepo = false
```

在普通模式下，无法访问的私有/内部死代码以警告报告，公共符号则被视为可能供外部调用的 API。在 monorepo 模式下，未使用的公共符号也会被报告，并使用错误级别。

## 严重级别映射

| 编译器/分析器严重级别 | LSP 严重级别 |
|---|---|
| Error | 1 — 错误 |
| Warning | 2 — 警告 |
| Info | 3 — 信息 |
| Hidden / hint | 4 — 提示 |

`server.debounce_ms` 字段会被接受以确保配置兼容性，但目前尚未应用。诊断请求会立即启动，过时的结果则由版本代次门控抑制。
