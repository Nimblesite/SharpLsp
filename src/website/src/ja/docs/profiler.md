---
layout: layouts/docs.njk
title: プロファイラー
lang: ja
eleventyExcludeFromCollections: true
---

![VS Code でのプロファイラー](/assets/screenshots/vscode-profiler-page.png)

# プロファイラー

SharpLsp は、.NET のトレース、カウンター、ダンプ、ヒープ解析の各ワークフローを VS Code のサイドバーから利用できるようにします。これらの処理は Rust ホスト内で動作し、どちらの言語サイドカーにも依存しません。

## 必要なツール

必要な Microsoft 診断ツールをインストールします。

```sh
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

SharpLsp は最初に `PATH` を確認し、次に現在のユーザーのホームディレクトリ下にある標準の `.dotnet/tools` ディレクトリを確認します。`dotnet tool list -g` は実行しません。ツールが見つからない場合は、対応するインストールコマンドを含むエラーを返します。

## プロファイラービュー

**Profiler** ビューには次が表示されます。

- 実行中のトレースセッションとカウンターセッション
- 検出可能な .NET プロセスと、その PID およびコマンドライン
- セッションごとの出力先と操作項目

Refresh を実行するとプロセス一覧が更新されます。プロセスのコンテキストアクションから、トレースの開始、カウンターの開始、ダンプの収集、PID のコピー、プロセスの終了を実行できます。

## トレース

1. **SharpLsp: Start Performance Trace** を実行し、.NET プロセスを選択します。
2. **SharpLsp: Stop Performance Trace** を実行するか、ツリー項目からセッションを停止します。
3. SharpLsp が `.nettrace` を完成させて SpeedScope JSON に変換し、SpeedScope ビューアーで開きます。

リクエスト値を明示しない場合、現在のトレースリクエストは既定で 30 秒間実行され、`.sharplsp/profiles` 以下へ出力されます。既存の `.nettrace` を開き、SpeedScope 形式へ変換することもできます。

## ライブカウンター

**Start Counter Monitoring** は、選択したプロセスに対して `dotnet-counters` を起動し、ライブ Webview を開きます。既定のプロバイダーは `System.Runtime`、更新間隔は 1 秒です。セッションが停止するまで、カウンターの更新は `sharplsp/profiler/counterUpdate` 通知で届きます。

## ダンプとヒープ解析

拡張機能では次の操作ができます。

- Heap、Full、Mini の各ダンプを収集する
- `dumpheap -stat` を実行し、型ごとの個数とサイズを表示する
- 2 つのダンプスナップショットを比較する
- baseline → exercise → comparison の手順に沿ってメモリリークを検出する
- アドレスを指定してオブジェクトを調査する
- 範囲を制限したオブジェクト参照グラフを構築し、GC ルートを特定する

ヒープ差分は、個数とサイズの増減から増加候補を分類します。これはヒューリスティックであり、リークの証明ではありません。保持パスとアプリケーションの挙動を確認して判断してください。

## 主なコマンド

| コマンド | 用途 |
|---|---|
| `SharpLsp: Refresh Profiler` | プロセスとセッションを更新 |
| `SharpLsp: Start Performance Trace` / `Stop Performance Trace` | トレースを記録して終了 |
| `SharpLsp: Open Trace File…` / `Convert .nettrace to SpeedScope` | トレースファイルを開く、または変換 |
| `SharpLsp: Start Counter Monitoring` / `Stop Counter Monitoring` | ランタイムカウンターを監視 |
| `SharpLsp: Collect Memory Dump` | メモリダンプを収集 |
| `SharpLsp: Analyze Heap Dump` | ヒープ統計を表示 |
| `SharpLsp: Compare Heap Snapshots` | 2 つのダンプの差分を表示 |
| `SharpLsp: Detect Memory Leaks` | ガイド付きスナップショットワークフローを実行 |
| `SharpLsp: Show Object Retention Graph` | オブジェクト参照を可視化 |
| `SharpLsp: Inspect Object` | 1 つのオブジェクトのフィールドと参照を表示 |

## 設定の適用状況

`sharplsp.toml` では、[設定](/ja/docs/configuration/)ページに示すプロファイラー設定をすべて記述できます。現在、実行時の動作に適用されるのは `profiler.max_concurrent_sessions` だけです。その他のプロファイラー既定値もパースされますが、コマンドは組み込みのリクエスト既定値を引き続き使用します。設定を変更しても、トレース時間、出力形式、カウンタープロバイダー／間隔、出力ディレクトリはまだ変更されません。

セッション数の既定上限は 5 です。上限を超えた場合、既存のセッションを置き換えるのではなくエラーを返します。

## 安全性とエラー

プロファイラーコマンドは PID、ファイル、セッション ID、ツールの有無を検証し、LSP を介してエラーを返します。プロセスツリーには明示的な終了アクションもあります。選択した外部プロセスを終了するため、慎重に使用してください。
