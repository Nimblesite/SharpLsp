# SharpLsp for VS Code

开源的 .NET Language Server——为每个编辑器提供 C# 和 F# 智能感知。零许可证，零厂商锁定。

> 🌐 **其他语言：** [English](https://sharplsp.dev/) · [日本語](https://sharplsp.dev/ja/)

## 功能

- **代码补全** — 由 Roslyn 驱动的 IntelliSense 级别补全
- **诊断** — 输入时的实时错误和警告
- **悬停 / 快速信息** — 完整的类型签名、XML 文档和可空性注释
- **转到定义** — 跳转到源代码或反编译的元数据
- **文档符号** — 通过 tree-sitter 提供的快速大纲
- **代码折叠** — 语法感知的区域折叠
- **F# 支持** — 通过 FSharp.Compiler.Service 提供一流的 F# 支持
- **解决方案资源管理器** — 你的 .sln/.slnx、项目和符号的树视图
- **性能分析器** — 内置的 .NET 性能分析、计数器监控和内存分析

## 性能分析器

SharpLsp 将 `dotnet-trace`、`dotnet-counters` 和 `dotnet-dump` 包装成无缝的编辑器体验。无需终端。

### 安装

安装 .NET 诊断工具：

```bash
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

### 使用

在 SharpLsp 侧边栏中打开**性能分析器**面板，查看正在运行的 .NET 进程。

| 操作 | 方法 |
|--------|-----|
| **跟踪性能** | `SharpLsp: Start Trace` — 选择一个进程，跟踪将持续运行直到你停止。输出将在 SpeedScope 中打开。 |
| **监控计数器** | `SharpLsp: Start Counters` — 在 webview 面板中以实时更新的表格显示 .NET 性能计数器。 |
| **捕获内存转储** | `SharpLsp: Collect Dump` — 选择 Heap、Full 或 Mini 转储类型。 |
| **分析堆** | `SharpLsp: Analyze Heap` — 选择一个 `.dmp` 文件以查看类型计数和内存使用情况。 |

所有命令都可以从命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`）调用。

## 系统要求

- .NET SDK 10.0+
- `sharplsp` 二进制文件（从源代码构建或从发行版下载）

## 配置

通过工作区根目录中的 `sharplsp.toml` 进行配置。详情请参阅[完整文档](https://sharplsp.dev/zh/docs/configuration/)。

## 链接

- [文档](https://sharplsp.dev/zh/docs/)
- [GitHub](https://github.com/Nimblesite/SharpLsp)
- [Issues](https://github.com/Nimblesite/SharpLsp/issues)
