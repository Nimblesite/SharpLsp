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

第一次打开 C# 或 F# 文件时，SharpLsp 会下载它的服务器。

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

如果 SharpLsp 没有启动，请运行 `zed: open log` 查看原因。
