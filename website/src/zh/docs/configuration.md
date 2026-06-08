---
layout: layouts/docs.njk
title: 配置
lang: zh
eleventyNavigation:
  key: 配置（中文）
  order: 9
---

# 配置

![VS Code 中的 SharpLsp 工作区配置](/assets/screenshots/vscode-configuration-page.png)

SharpLsp 通过放置在工作区根目录（与 `.sln` 或根 `.csproj` 同级）的 `sharplsp.toml` 文件进行配置。所有设置都有合理的默认值——该文件是可选的。

`sharplsp.toml` 使用 `deny_unknown_fields`：未在下方列出的任何键都会在启动时引发解析错误。

## sharplsp.toml 参考

```toml
# sharplsp.toml — 完整配置参考
# 所有键均为可选；省略时使用默认值。

# ─── 服务器 ────────────────────────────────────────────────────────────────────
[server]
# 日志级别："trace"、"debug"、"info"、"warn"、"error"
log_level = "info"

# 按键后语义请求的防抖窗口（毫秒）
debounce_ms = 150

# ─── C# ────────────────────────────────────────────────────────────────────────
[csharp]
# 启用 C# sidecar
enabled = true

# 要加载的 .sln 文件路径。空字符串 = 自动检测。
solution_path = ""

# ─── F# ────────────────────────────────────────────────────────────────────────
[fsharp]
# 启用 F# sidecar
enabled = true

# ─── 诊断 ───────────────────────────────────────────────────────────────────────
[diagnostics]
# 运行 Roslyn 分析器（不仅是编译器错误）
analyzers_enabled = true

# 分析解决方案中的所有文件，而不仅是已打开的文件
solution_wide_analysis = true

# 要包含的项目名模式（空 = 所有项目）
project_filter = []

# ─── 性能分析器 ────────────────────────────────────────────────────────────────
[profiler]
# 最大并发分析会话数
max_concurrent_sessions = 5

# 默认追踪时长（秒，0 = 无限）
default_trace_duration = 30

# 默认追踪输出格式（"speedscope"、"chromium"、"nettrace"）
default_trace_format = "speedscope"

# 默认计数器提供程序
default_counter_providers = ["System.Runtime"]

# 默认计数器刷新间隔（秒）
default_counter_interval = 1

# 追踪 / dump 文件的输出目录
output_directory = ".sharplsp/profiles"
```

## 文件位置

SharpLsp 从工作区根目录向上遍历目录树来查找 `sharplsp.toml`。找到的第一个 `sharplsp.toml` 将被使用。如果未找到，则应用所有默认值。

```
my-solution/
├── sharplsp.toml          ← 放在这里
├── MyApp.sln
├── MyApp.Core/
│   └── MyApp.Core.csproj
└── MyApp.Api/
    └── MyApp.Api.csproj
```

## 每个项目的覆盖设置

Roslyn 将 `.editorconfig` 严重性设置直接映射到分析器严重性：

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.IDE0003.severity = warning   # 删除 'this' 限定符
dotnet_diagnostic.CA1054.severity = error       # URI 参数不应为字符串
```

## 禁用某种语言

要完全跳过启动某个 sidecar，将其 `enabled` 标志设为 `false`：

```toml
[fsharp]
enabled = false
```

该语言的请求将被拒绝，且不会派生 sidecar 进程。
