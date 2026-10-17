---
layout: layouts/docs.njk
title: Zed での SharpLsp
description: "Zed エディターで C# と F# のために SharpLsp をインストールして使う方法。"
lang: ja
---

# Zed での SharpLsp

[Zed](https://zed.dev) で使える C# と F# のコードインテリジェンスです。

## インストール

1. [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) と [Rust](https://www.rust-lang.org/ja/tools/install) をインストールします。
2. Zed で拡張機能ページを開き、**C#** と **F#** をインストールします。
3. SharpLsp をクローンします。

   ```sh
   git clone https://github.com/Nimblesite/SharpLsp.git
   ```

4. 拡張機能ページで **Install Dev Extension** をクリックし、クローンの中の `src/editors/zed` フォルダーを選択します。
5. .NET プロジェクトのフォルダーを開き、Zed に尋ねられたら信頼します。

初めて C# または F# のファイルを開いたときに、SharpLsp がサーバーをダウンロードします。

## 他の C# と F# のサーバーではなく SharpLsp を使う

Zed の設定（`zed: open settings file`）に次を追加します。

```json
{
  "languages": {
    "CSharp": { "language_servers": ["sharplsp", "!omnisharp", "!roslyn", "!csharp-ls", "..."] },
    "FSharp": { "language_servers": ["sharplsp", "!fsautocomplete", "..."] }
  }
}
```

SharpLsp が起動しない場合は、`zed: open log` を実行して原因を確認してください。
