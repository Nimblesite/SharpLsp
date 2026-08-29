---
layout: layouts/docs.njk
title: 架构
lang: zh
eleventyNavigation:
  key: 架构（中文）
  order: 2
---

# 架构

![VS Code 中的 SharpLsp 架构](/assets/screenshots/vscode-architecture-page.png)

SharpLsp 将编辑器协议处理与由编译器提供支持的语义分析分离开来。

{% include "partials/architecture-diagram.njk" %}

## 第一层 — Rust LSP 宿主

宿主进程负责：

- 通过标准输入输出使用 LSP 3.17 JSON-RPC；
- 全文档文本同步和内存 VFS；
- 使用 C# tree-sitter 解析来提供文档符号、折叠、选择范围、关联编辑和语法预验证；
- 将请求路由到正确的语言 sidecar；
- sidecar 的启动、健康检查、重启退避和关闭；
- 诊断传递、NuGet 请求处理和性能分析器请求处理。

宿主目前只包含 C# tree-sitter 语法。F# 文档符号和工作区符号会路由到 FCS；F# 折叠和选择范围尚不可用。

尽管 tree-sitter 为增量解析而设计，但当前的全文同步路径会在每次变更后从一棵新树开始重新解析 C# 文档。SharpLsp 目前不依赖 salsa。

## 第二层 — C# Sidecar

一个长时间运行的 .NET 10 进程承载 Roslyn 和 `MSBuildWorkspace`。它提供 C# 代码补全、悬停信息、诊断、导航、引用查找、重命名、代码操作、语义令牌、内联提示、Code Lens 和层级查询。C# 文档符号和工作区符号则由 Rust 宿主的 tree-sitter 路径生成。

共享的 ICSharpCode.Decompiler 组件可为许多 BCL 和引用程序集中的符号生成“元数据即源码”位置。

## 第三层 — F# Sidecar

另一个独立的 .NET 10 进程承载 `FSharpChecker`。它通过 SharpLsp 自有的项目/选项代码加载 F# 项目信息，并提供 F# 代码补全、悬停信息、签名帮助、诊断、导航、引用查找、重命名、符号、代码操作、语义令牌、内联提示、CodeLens 和层级查询。

sidecar 内部已有 Fantomas 格式化代码，但宿主有意不对其进行路由或声明支持。FSharpLint 是项目依赖项，但尚未接入诊断管线。

## IPC

宿主使用以下机制与每个 sidecar 通信：

- MessagePack 负载；
- Windows 上的命名管道，或 Linux 和 macOS 上的 Unix 域套接字；
- 4 字节小端序长度前缀；
- 带关联标识的请求/响应信封。

sidecar 故障不会导致宿主退出。生命周期管理器会将该进程标记为不可用，应用重启退避，并可启动替代进程。

## 请求路由

| 请求类型 | 当前路由 | 示例 |
|---|---|---|
| C# 语法 | Rust + tree-sitter | 文档符号、折叠、选择范围 |
| F# 符号 | F# sidecar + FCS | 文档符号、工作区符号 |
| C# 语义 | C# sidecar + Roslyn | 代码补全、悬停信息、定义、代码操作 |
| F# 语义 | F# sidecar + FCS | 代码补全、悬停信息、定义、签名帮助 |
| 宿主服务 | Rust | 诊断传递、NuGet 编排、性能分析 |

SharpLsp 不声明支持任何一种语言的格式化。C# 请使用 CSharpier，F# 请使用专门的 Fantomas 集成。

项目其他位置列出的延迟值是工程目标，并非针对每个代码库、机器或冷启动状态的保证。
