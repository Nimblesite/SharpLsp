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

SharpLsp 通过放置在工作区根目录（与 `.sln` 或根 `.csproj` 同级）的 `sharplsp.toml` 文件进行配置。所有设置都有合理的默认值 — 该文件是可选的。

## sharplsp.toml 参考

```toml
# sharplsp.toml — 完整配置参考

# ─── 诊断 ───────────────────────────────────────────────────────────────
[diagnostics]
# 运行 Roslyn 分析器（不仅仅是编译器错误）
analyzers_enabled = true

# 分析解决方案中的所有文件，而不仅仅是打开的文件
solution_wide_analysis = true

# 将分析限制在特定项目（glob 模式）
# 空 = 分析所有项目
project_filter = []

# 要报告的最低严重性："error"、"warning"、"info"、"hint"
min_severity = "hint"

# 每个文件的最大诊断数（0 = 无限制）
max_per_file = 0

# 触发重新分析前的防抖窗口（毫秒）
debounce_ms = 150

# ─── 代码补全 ───────────────────────────────────────────────────────────────
[completions]
# 显示未导入程序集中的类型（自动添加 using/open）
import_completions = true

# 每次请求的最大结果数
max_results = 200

# ─── Sidecar ───────────────────────────────────────────────────────────────
[sidecar]
# 放弃前的最大重启次数（0 = 无限制）
max_restarts = 10

# 重启尝试之间的延迟（毫秒，每次尝试加倍）
restart_delay_ms = 500

# ─── 日志 ───────────────────────────────────────────────────────────────
[log]
# 日志级别："trace"、"debug"、"info"、"warn"、"error"
level = "info"

# 日志文件路径（空 = 仅 stderr）
file = ""
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

## 热重载

大多数设置可通过 `workspace/didChangeConfiguration` 热重载。对 `solution_wide_analysis`、`project_filter`、`min_severity` 和 `analyzers_enabled` 的更改无需重启 SharpLsp 即可生效。

需要重启的设置：
- `[sidecar]` 设置
- `[log]` 设置

## 每个项目的覆盖设置

对于精细控制，C# 格式化支持 `.editorconfig` 规则。Roslyn 将 `.editorconfig` 严重性设置直接映射到分析器严重性：

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.IDE0003.severity = warning   # 删除 'this' 限定符
dotnet_diagnostic.CA1054.severity = error       # URI 参数不应为字符串
```

## 环境变量

| 变量 | 描述 |
|----------|-------------|
| `SHARPLSP_LOG` | 覆盖日志级别（例如，`SHARPLSP_LOG=debug`）|
| `SHARPLSP_CONFIG` | 覆盖 `sharplsp.toml` 路径 |
| `SHARPLSP_DOTNET_ROOT` | 覆盖用于 MSBuild 发现的 .NET SDK 根目录 |

## 禁用功能

在最小模式下运行 SharpLsp（仅语法，无 sidecar）：

```toml
[diagnostics]
analyzers_enabled = false
solution_wide_analysis = false

[completions]
import_completions = false
```

这将禁用 sidecar 启动和所有语义操作。SharpLsp 仍将以全速提供 tree-sitter 驱动的文档符号、折叠范围和选择范围。
