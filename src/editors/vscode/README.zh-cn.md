<p align="center">
  <img src="https://sharplsp.dev/assets/images/marketplace/sharplsp-tour.gif" width="100%" alt="SharpLsp 导览：Visual Studio 和 Rider 的开源替代方案——在 VS Code、Cursor 和 Windsurf 中使用解决方案资源管理器、NuGet 浏览器、C# 与 F#、调试、性能分析和测试">
</p>

<h1 align="center">SharpLsp</h1>

<p align="center">
  <strong>Visual Studio 和 Rider 的开源替代方案。</strong><br>
  完整的 C# 与 F#——NuGet、调试、性能分析和测试——就在你已经在用的编辑器里。
</p>

<p align="center">
  <a href="https://sharplsp.dev/zh/docs/">文档</a> ·
  <a href="https://sharplsp.dev/zh/blog/">博客</a> ·
  <a href="https://github.com/Nimblesite/SharpLsp">GitHub</a> ·
  <a href="https://github.com/Nimblesite/SharpLsp/issues">Issues</a> ·
  <a href="https://sharplsp.dev/">English</a> ·
  <a href="https://sharplsp.dev/ja/">日本語</a>
</p>

## 🥊 告别笨重的 IDE，能力一样不少。

解决方案资源管理器、项目与包引用、生成、重构、NuGet、调试器、性能分析器和测试资源管理器——完整的 IDE 工作流，全部在 VS Code 里。**无需订阅。无需许可证服务器。无需账户。永远 MIT。**

<p align="center">
  <img src="https://sharplsp.dev/assets/images/marketplace/sharplsp-explorer.png" width="100%" alt="SharpLsp 解决方案资源管理器：.NET 解决方案、项目、依赖项和 C# 符号，旁边是 Roslyn 高亮的代码">
</p>

## ⚖️ C# 与 F#，一视同仁。

C# 由 **Roslyn** 驱动，F# 由 **FSharp.Compiler.Service** 驱动。两者都有补全、悬停、转到定义、查找引用、重命名、代码操作、语义高亮、内嵌提示和实时诊断，也共享同一套解决方案资源管理器、测试资源管理器、调试器和性能分析器。

F# 还额外提供 **F# Interactive**、`.fsi` 签名文件生成和管道类型提示。

## 🐞 调试、性能分析、测试——好东西全都有。

| | |
| --- | --- |
| 🐞 **调试** | F5、断点、单步执行和热重载。内置 MIT 许可的 netcoredbg 调试器。 |
| 🔥 **性能分析** | 在 SpeedScope 中查看 CPU 跟踪，实时计数器、内存转储、堆差异、泄漏检测和保留关系图。 |
| 🧪 **测试** | 支持 xUnit、NUnit、MSTest、Expecto 和 FsCheck 的测试资源管理器与 CodeLens——VSTest 和 MTP，C# 和 F# 皆可。 |
| 📦 **NuGet** | 浏览、安装、更新、移除和合并包。无需终端。 |

<p align="center">
  <img src="https://sharplsp.dev/assets/images/marketplace/sharplsp-nuget.png" width="100%" alt="SharpLsp NuGet 浏览器：带下载量的包列表，以及带安装按钮的包详情面板">
</p>

## 🌍 随处运行。

**Windows 和 Linux**（x64 与 Arm64）以及 **macOS**（Apple 芯片）。可从 VS Code Marketplace 或 **Open VSX** 安装——**VS Code、Cursor、Windsurf、VSCodium** 等都能用。调试器同样开源，因此在每一个编辑器里都能按 F5。

## ⚡ 30 秒上手

1. 安装 **SharpLsp**。
2. 打开包含 `.sln`、`.slnx`、`.csproj` 或 `.fsproj` 的文件夹。
3. 开始写代码。

扩展内置语言服务器、两个 .NET 边车进程和调试器；如果没有 **.NET 10 SDK**，会通过 Microsoft 的 .NET Install Tool 自动获取。性能分析器使用标准的 .NET 诊断工具，只需安装一次：

```bash
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

在工作区中使用 `sharplsp.toml` 调整一切——参见[配置指南](https://sharplsp.dev/zh/docs/configuration/)。

## 💚 开源

SharpLsp 在 [GitHub](https://github.com/Nimblesite/SharpLsp) 上以 MIT 许可证公开开发。欢迎提交问题、想法和拉取请求。
