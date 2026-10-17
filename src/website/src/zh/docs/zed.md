---
layout: layouts/docs.njk
title: 在 Zed 中使用 SharpLsp
description: "在 Zed 编辑器中为 C# 和 F# 安装和使用 SharpLsp。"
lang: zh
---

# 在 Zed 中使用 SharpLsp

为 [Zed](https://zed.dev) 提供 C# 和 F# 代码智能功能。

## 安装

1. 安装 [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) 和 [Rust](https://www.rust-lang.org/zh-CN/tools/install)。
2. 在 Zed 中打开扩展页面，安装 **C#** 和 **F#**。
3. 克隆 SharpLsp：

   ```sh
   git clone https://github.com/Nimblesite/SharpLsp.git
   ```

4. 在扩展页面点击 **Install Dev Extension**，选择克隆目录中的 `src/editors/zed` 文件夹。
5. 打开你的 .NET 项目文件夹，Zed 询问时选择信任。
6. 如果文件夹中任何位置有多个 `.sln` 或 `.slnx` 文件，请按照下面的“选择解决方案”操作。否则 SharpLsp 不会加载任何 C# 项目。

第一次打开 C# 或 F# 文件时，SharpLsp 会下载它的服务器。

## 选择解决方案

对于 C#，SharpLsp 会在你打开的整个文件夹（包括子文件夹）中查找 `.sln` 和 `.slnx` 文件。如果只找到一个，就加载它。如果找到多个，它会**一个都不**加载，因为它无法判断你要哪一个。你仍然有语法高亮（来自 Zed 的 C# 扩展），但 C# 文件中没有悬停信息、补全、转到定义和诊断。F# 项目无论如何都会加载。SharpLsp 语言服务器日志会显示：

```text
Found 11 solutions under '/path/to/folder' (...), so which one to load is ambiguous.
```

解决方法：

1. 在你用 Zed 打开的文件夹中创建名为 `sharplsp.toml` 的文件。
2. 在其中写入你要使用的解决方案的路径，路径相对于该文件夹：

   ```toml
   [csharp]
   solution_path = "src/MyApp.sln"
   ```

3. 按 <kbd>Cmd+Shift+P</kbd>（在 Linux 和 Windows 上按 <kbd>Ctrl+Shift+P</kbd>），运行 `editor: restart language server`。

将鼠标悬停在任意类型上，确认已经生效。

解决方案必须在 `sharplsp.toml` 中设置。在 Zed 的设置文件中设置 `solution_path` 不起作用：SharpLsp 在启动时、Zed 发送任何设置之前就已选定解决方案。

## 使用 SharpLsp 代替其他 C# 和 F# 服务器

在 Zed 设置（`zed: open settings file`）中添加：

```json
{
  "languages": {
    "CSharp": { "language_servers": ["sharplsp", "!omnisharp", "!roslyn", "!csharp-ls", "..."] },
    "FSharp": { "language_servers": ["sharplsp", "!fsautocomplete", "..."] }
  }
}
```

## 故障排除

| 问题 | 解决方法 |
|---|---|
| C# 文件有语法高亮，但没有悬停信息、补全和诊断 | 文件夹中有多个解决方案。请参阅“选择解决方案”。 |
| SharpLsp 始终没有启动 | 安装 Zed 的 C# 和 F# 扩展，并信任该文件夹。 |
| 补全或诊断出现两次 | 另一个 C# 或 F# 服务器仍在运行。请参阅“使用 SharpLsp 代替其他 C# 和 F# 服务器”。 |

要查看出了什么问题，请打开命令面板（<kbd>Cmd+Shift+P</kbd> 或 <kbd>Ctrl+Shift+P</kbd>）并运行：

- `zed: open log`：排查安装或下载 SharpLsp 的问题；
- `dev: open language server logs`，然后选择 **SharpLsp**：排查运行后的问题。
