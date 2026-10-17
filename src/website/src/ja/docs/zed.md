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
6. フォルダー内のどこかに `.sln` または `.slnx` ファイルが複数ある場合は、下の「ソリューションを選ぶ」に従ってください。そうしないと SharpLsp は C# プロジェクトを何も読み込みません。

初めて C# または F# のファイルを開いたときに、SharpLsp がサーバーをダウンロードします。

## ソリューションを選ぶ

C# の場合、SharpLsp は、開いたフォルダー全体（サブフォルダーを含む）から `.sln` と `.slnx` ファイルを探します。1 つだけ見つかれば、それを読み込みます。複数見つかった場合は、どれを使えばよいか判断できないため、**どれも**読み込みません。構文ハイライトは Zed の C# 拡張機能によるものなので引き続き表示されますが、C# ファイルではホバー、補完、定義へ移動、診断は使えません。F# プロジェクトはどちらの場合も読み込まれます。SharpLsp はエラーを表示し、言語サーバーログには次のように記録されます。

```text
Found 11 solutions under '/path/to/folder' (...), so which one to load is ambiguous.
```

解決するには、Zed の設定か `sharplsp.toml` ファイルでソリューションを指定します。両方で指定した場合は、Zed の設定が優先されます。

### Zed の設定で指定する

1. <kbd>Cmd+Shift+P</kbd>（Linux と Windows では <kbd>Ctrl+Shift+P</kbd>）を押し、`zed: open project settings` を実行します。
2. 使いたいソリューションのパスを、開いたフォルダーからの相対パスで追加します。

   ```json
   {
     "lsp": {
       "sharplsp": {
         "settings": {
           "csharp": { "solution_path": "src/MyApp.sln" }
         }
       }
     }
   }
   ```

3. ファイルを保存します。SharpLsp は再起動なしでソリューションを読み込みます。

### `sharplsp.toml` で指定する

1. Zed で開いたフォルダーに `sharplsp.toml` という名前のファイルを作成します。
2. 使いたいソリューションのパスを、そのフォルダーからの相対パスで書きます。

   ```toml
   [csharp]
   solution_path = "src/MyApp.sln"
   ```

3. <kbd>Cmd+Shift+P</kbd>（Linux と Windows では <kbd>Ctrl+Shift+P</kbd>）を押し、`editor: restart language server` を実行します。

任意の型にマウスを重ねて、動作していることを確認します。

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

## トラブルシューティング

| 問題 | 対処 |
|---|---|
| C# ファイルで構文ハイライトは表示されるが、ホバー、補完、診断が使えない | フォルダーに複数のソリューションがあります。「ソリューションを選ぶ」を参照してください。 |
| SharpLsp がまったく起動しない | Zed の C# と F# の拡張機能をインストールし、フォルダーを信頼してください。 |
| 補完や診断が 2 回表示される | 別の C# または F# のサーバーがまだ動いています。「他の C# と F# のサーバーではなく SharpLsp を使う」を参照してください。 |

原因を確認するには、コマンドパレット（<kbd>Cmd+Shift+P</kbd> または <kbd>Ctrl+Shift+P</kbd>）を開いて次を実行します。

- SharpLsp のインストールやダウンロードの問題には `zed: open log`
- 起動後の問題には `dev: open language server logs` を実行し、**SharpLsp** を選択
