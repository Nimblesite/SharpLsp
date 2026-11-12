---
layout: layouts/docs.njk
lang: ja
title: "C# と F# を同じセッションでデバッグ"
description: "SharpLsp を使い、VS Code で C# から F# にステップインします。"
---

# C# と F# を同じセッションでデバッグ

C# の呼び出し元から F# ライブラリへ移動し、同じデバッグセッションで戻ります。映像は .NET 10 と実際の VS Code を使用しています。英語のナレーションと字幕があります。

{% video "debugging" %}

両プロジェクトの共通の親フォルダーを開き、`dotnet build Checkout/Checkout.csproj` を実行します。次の設定を `.vscode/launch.json` に保存し、`program` を実際の Debug アセンブリに合わせてください。

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

1. C# から F# を呼ぶ行で **F9** を押し、**F5** で起動します。
2. **Variables > Locals** と **Watch** で値を確認します。
3. **F11** で F# に入り、**F10** で各文を実行します。
4. **Shift+F11** で C# に戻り、**F5** で続行します。

ブレークポイントで停止しない場合は Debug 構成で再ビルドし、アセンブリと `.pdb` を同じ場所に置いてください。`cwd` は両プロジェクトの共通ルートにします。映像にはローカルビルドの SharpLsp を使用しています。
