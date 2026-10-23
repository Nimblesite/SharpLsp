---
layout: layouts/docs.njk
title: 配置
description: "配置 SharpLsp：sharplsp.toml 中的工作区服务器设置、VS Code 中的 sharplsp.* 客户端设置、文件位置，以及 monorepo 模式。"
lang: zh
eleventyNavigation:
  key: 配置（中文）
  order: 9
---

# 配置

<img src="/assets/screenshots/docs/configuration.webp" alt="在 Shop 解决方案旁打开的 sharplsp.toml，包含 server、csharp、fsharp、diagnostics 和 analyzers 各节" width="2400" height="1500">

SharpLsp 有两类配置入口：

{% video "configuration" %}

- `sharplsp.toml` 中的工作区级服务器设置；
- VS Code 中 `sharplsp.*` 下的客户端和界面设置。

两者不能互换。尤其要注意，FSI 参数和内联提示显示设置属于 VS Code 设置，而不是 TOML 字段。

## sharplsp.toml 的位置

将 `sharplsp.toml` 放在解决方案或项目旁边。SharpLsp 从工作区根目录开始向上查找，并使用找到的第一个文件。在单文件模式下，它从服务器的当前目录开始查找。

该模式使用 `deny_unknown_fields`。键名拼写错误或使用不受支持的键会导致启动错误。

## 完整 TOML 模式

```toml
[testing]
configuration = "Debug"

[debug.exceptions]
break_on = "editor"
just_my_code = true
external_code = "throw-site"
ignore = []

[server]
log_level = "info"
debounce_ms = 150

[csharp]
enabled = true
solution_path = ""

[fsharp]
enabled = true

[diagnostics]
analyzers_enabled = true
solution_wide_analysis = true
project_filter = []
min_severity = "hint"
max_per_file = 0
refresh_debounce_ms = 2000

[analyzers]
dead_code = true
monorepo = false

[profiler]
max_concurrent_sessions = 5
output_directory = ".sharplsp/profiles"
```

每个字段都是可选的。省略字段时会使用上面显示的值。

## 测试和调试

`testing.configuration` 选择测试发现、执行、覆盖率和调试所用的 MSBuild 配置。即使项目默认为 Release，此设置也默认为 `Debug`。需要时可改为 `Release` 或自定义配置名，更改会在下一次操作时生效。运行选定测试时，仅增量构建所属项目及其依赖项，不构建无关的测试项目。构建失败时不会运行旧程序集。

将 `debug.exceptions.break_on` 设为 `all` 可在已处理的异常处暂停；`unhandled` 仅在未处理的终止异常处暂停，`editor` 则遵循调试器的异常复选框。Just My Code 会跳过外部代码内部处理的异常。设置 `just_my_code = false` 后，外部异常也会触发暂停：`external_code = "throw-site"` 显示原始源码，`"user-boundary"` 显示用户代码中的调用位置，并保留异常详情。显式指定的启动 `cwd` 定义用户源码根目录；未指定时使用工作区文件夹。

测试平台自己的 DLL 可能预先以 Release 模式构建。相关警告不表示用户的测试程序集也使用了 Release 模式。

## 会影响运行时行为的设置

| 字段 | 行为 |
|---|---|
| `csharp.enabled` | 启动或跳过 C# sidecar |
| `csharp.solution_path` | 选择一个 `.sln` 或 `.slnx`；可使用绝对路径或相对于工作区的路径 |
| `fsharp.enabled` | 启动或跳过 F# sidecar |
| `diagnostics.analyzers_enabled` | 启用 F# 和 C# 分析器诊断；不会隐藏编译器错误 |
| `diagnostics.solution_wide_analysis` | 解决方案诊断包含未打开的 F# 和 C# 文件；默认启用 |
| `diagnostics.project_filter` | 按项目名称或相对于所选解决方案的项目路径筛选 F# 和 C# 工作区结果；直接文档拉取不受影响 |
| `diagnostics.min_severity` | 设置最低严重级别：`error`、`warning`、`info` 或 `hint`；默认为 `hint` |
| `diagnostics.max_per_file` | 先按严重级别筛选，再限制每个文件的数量；`0` 表示不限制 |
| `diagnostics.refresh_debounce_ms` | 在指定的毫秒窗口内合并诊断刷新请求；默认为 `2000`，支持实时更改 |
| `analyzers.dead_code` | 启用 SharpLsp 的 C# 和 F# 死代码分析器 |
| `analyzers.monorepo` | 将未使用的公共符号视为死代码，并将其报告为错误 |
| `profiler.max_concurrent_sessions` | 限制同时运行的性能分析器会话数 |

如果 `solution_path` 为空，SharpLsp 会使用工作区发现。包含多个解决方案的工作区存在歧义，在你选择一个解决方案之前可能不会加载任何解决方案。如果配置的路径不是文件，服务器会记录警告，然后回退到工作区发现。

禁用某种语言会阻止其 sidecar 启动。C# 可能仍可使用宿主中只涉及语法的行为，但对已禁用语言的语义请求不会返回有用结果。

## 已接受但尚未应用

以下字段会被解析并保留以确保兼容性，但更改它们目前不会改变所述行为：

- `server.log_level`；
- `server.debounce_ms`；
- 除 `max_concurrent_sessions` 以外的所有 `profiler.*` 默认值。

如需配置 VS Code 日志，请使用 `sharplsp.logging.level`；它会作为 `RUST_LOG` 转发给宿主。性能分析器命令目前使用请求自身的默认值，并将文件写入 `.sharplsp/profiles`。

## 常用 VS Code 设置

| 设置 | 用途 |
|---|---|
| `sharplsp.logging.level` | 宿主日志过滤器 |
| `sharplsp.lspPath` | 受信任工作区中的服务器二进制文件替代路径 |
| `sharplsp.csharpSidecarPath` / `sharplsp.fsharpSidecarPath` | 受信任工作区中的 sidecar 替代路径 |
| `sharplsp.server.extraArgs` | 受信任工作区中的额外服务器参数 |
| `sharplsp.fsi.extraArgs` | 传递到 `dotnet fsi` 之后的参数 |
| `sharplsp.inlayHints.parameterNames` | 预留的参数名称提示开关；尚未应用 |
| `sharplsp.inlayHints.typeInference` | 预留的推断类型提示开关；尚未应用 |
| `sharplsp.inlayHints.pipelineTypes` | 预留的 F# 管道提示开关；尚未应用 |
| `sharplsp.nuget.includePrerelease` | 在搜索中包含预发行版包 |
| `sharplsp.hotReload.onSave` | 保存时触发热重载 |
| `sharplsp.testLens.enabled` | 显示测试 CodeLens 操作 |
| `sharplsp.solutionExplorer.autoReveal` | 在树中跟随活动编辑器 |

成员排序顺序和调试适配器路径也可以在 VS Code 设置界面中配置。

这三个内联提示设置已注册，扩展也可以读取它们，但目前没有任何生产路径使用它们来筛选返回的提示。因此，更改这些设置尚不起作用。

## .editorconfig

Roslyn 和 FCS 会通过各自常规的工作区输入读取项目/编译器设置。SharpLsp 不会仅仅因为 `.editorconfig` 中设置了严重级别就运行任意第三方分析器包；已实现的诊断来源请参阅[诊断](/zh/docs/diagnostics/)。
