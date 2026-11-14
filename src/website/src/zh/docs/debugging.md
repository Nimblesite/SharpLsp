---
layout: layouts/docs.njk
lang: zh
title: "在同一会话中调试 C# 和 F#"
description: "使用 SharpLsp 在 VS Code 中从 C# 单步进入 F#。"
---

# 在同一会话中调试 C# 和 F#

从 C# 调用方进入 F# 库，再在同一调试会话中返回。视频使用 .NET 10 和真实的 VS Code，配有英语旁白和字幕。

{% video "debugging" %}

打开两个项目的共同父目录，运行 `dotnet build Checkout/Checkout.csproj`。将以下配置保存为 `.vscode/launch.json`，并将 `program` 改为应用的 Debug 程序集路径。

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "C# + F# checkout",
      "type": "sharplsp-coreclr",
      "request": "launch",
      "program": "${workspaceFolder}/Checkout/bin/Debug/net10.0/Checkout.dll",
      "cwd": "${workspaceFolder}",
      "console": "internalConsole",
      "justMyCode": true,
      "stopAtEntry": false
    }
  ]
}
```

1. 在 C# 调用 F# 的行上按 **F9**，再按 **F5** 启动。
2. 在 **Variables > Locals** 和 **Watch** 中查看值。
3. 按 **F11** 进入 F#，按 **F10** 逐条执行语句。
4. 按 **Shift+F11** 返回 C#，按 **F5** 继续运行。

如果断点未命中，请使用 Debug 配置重新构建，并将 `.pdb` 文件保留在程序集旁。将 `cwd` 设为两个项目的共同根目录。视频使用本地构建的 SharpLsp。
