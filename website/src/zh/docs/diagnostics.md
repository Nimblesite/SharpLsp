---
layout: layouts/docs.njk
title: 诊断
lang: zh
eleventyExcludeFromCollections: true
---

![VS Code 中的诊断](/assets/screenshots/vscode-diagnostics-page.png)

*Alpha 版 VS Code 扩展中的 Roslyn 诊断。*

# 诊断

SharpLsp 通过 C# sidecar 路由 C# 编译器错误、警告和 Roslyn 分析器诊断。当前网站展示的是 VS Code 扩展状态；F# 诊断仍在开发中。

## 工作原理

```
编辑器 ←→ Rust LSP 宿主 ←→ C# Sidecar
  ↑            ↑                ↑
问题       publishDiagnostics  Roslyn
窗口       通知               GetDiagnostics()
```

1. **文档变更** — 编辑器发送 `textDocument/didChange`，Rust 宿主更新 VFS 和 tree-sitter
2. **防抖** — 变更在 150ms 窗口内合并（可配置）
3. **分发** — Rust 宿主向 C# sidecar 发送 `workspace/diagnostics` 请求
4. **分析** — Roslyn 对受影响范围运行完整语义分析
5. **发布** — 结果映射到 LSP `Diagnostic` 对象并推送到编辑器

> **注意：** 诊断目前仅支持 C#。通过 FCS 的 F# 诊断尚未实现。

## 分析范围

| 模式 | 默认值 | 描述 |
|------|---------|-------------|
| **解决方案范围** | ✓ | 所有已加载项目中的所有文档 |
| 仅打开的文件 | ✗ | 仅当前在编辑器中打开的文档 |
| 按项目过滤 | ✗ | 按名称模式匹配的特定项目 |

解决方案范围分析是 SharpLsp 的方向之一。Alpha 版扩展仍在持续加固，因此请把诊断行为视为正在积极开发，而不是 beta 稳定性保证。

## 诊断类别

### 编译器诊断

| 语言 | 示例 |
|----------|----------|
| C#（Roslyn）| `CS0029`（类型转换）、`CS0246`（未找到类型）、`CS8600`–`CS8798`（可空性）|

### 分析器诊断

- **内置 Roslyn 分析器** — IDE0001–IDE0090、CA1000–CA2000 代码质量规则
- **.editorconfig 规则** — 从 `.editorconfig` 严重性映射的代码样式强制执行
- **第三方 NuGet 分析器** — StyleCop、SonarAnalyzer 和任何 `<Analyzer>` 引用

### 实时波浪线

诊断在三种情况下推送：

- **文档变更时** — 防抖窗口后重新分析
- **项目变更时** — `.csproj` / `.fsproj` 变更时重新分析
- **解决方案加载时** — 完整解决方案扫描，增量流式传输

## 配置

```toml
# sharplsp.toml
[diagnostics]
# 运行 Roslyn 分析器（不仅仅是编译器错误）
analyzers_enabled = true

# 分析解决方案中的所有文件，而不仅仅是打开的文件
solution_wide_analysis = true

# 按名称将分析限制到特定项目（空 = 所有）
project_filter = []
```

### 项目过滤器

为大型 monorepo 缩小范围：

```toml
[diagnostics]
project_filter = ["MyApp.Core", "MyApp.Api"]
```

## 性能目标

| 指标 | 目标 |
|--------|--------|
| 单文件刷新 | 按键后 <500ms |
| 解决方案范围初始扫描 | 50 个项目解决方案 <10s |
| 增量重新分析 | 单文件编辑后 <1s |
| 内存开销（解决方案范围） | 50 个项目 <200MB |

## 严重性映射

| Roslyn / FCS 严重性 | LSP 严重性 |
|-----------------------|-------------|
| Error | 1 — 错误 |
| Warning | 2 — 警告 |
| Info | 3 — 信息 |
| Hidden | 4 — 提示 |
