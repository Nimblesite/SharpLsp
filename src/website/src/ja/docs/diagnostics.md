---
layout: layouts/docs.njk
title: 診断
lang: ja
eleventyExcludeFromCollections: true
---

![VS Code での診断](/assets/screenshots/vscode-diagnostics-page.png)

# 診断

SharpLsp は C# と F# の両方についてコンパイラー診断を報告します。C# ファイルは Roslyn が、F# ファイルは F# Compiler Service が処理します。各サイドカーは現在のエディターバッファを解析するため、未保存の変更も含まれます。

## 配信モデル

SharpLsp は LSP の両方の診断モデルをサポートしています。

- **プッシュ:** 文書を開く、変更する、または保存するとバックグラウンド解析が開始され、`textDocument/publishDiagnostics` が送信されます。
- **文書プル:** `textDocument/diagnostic` は現在のファイルの診断を取得します。
- **C# ソリューションスキャン:** `diagnostics.solution_wide_analysis` が有効な場合、C# サイドカーは起動時に読み込まれたソリューションをスキャンし、結果を一度に 1 ファイルずつ公開します。

標準の `workspace/diagnostic` リクエストはサポート対象として通知されますが、現在は空のレポートを返します。ワークスペース全体の結果は、代わりに C# の起動時スキャンによって配信されます。F# のソリューション全体のプルはまだ実装されていません。

世代ゲートにより、古いバックグラウンドリクエストが新しい結果を上書きすることを防ぎます。文書を閉じると、診断を消去するために空のセットが公開されます。

## 診断ソース

| 言語 | 現在利用できるソース |
|---|---|
| C# | Roslyn コンパイラー診断と SharpLsp のデッドコード診断（`SLSPC0101`） |
| F# | FCS コンパイラー診断に加え、`SLSPF0101`（デッドコード）、`SLSPF0102`（未使用の `open`）、`SLSPF0103`（冗長な修飾子） |

サードパーティの Roslyn アナライザー実行と FSharpLint は、現在このパイプラインに接続されていません。そのため、受け付けられる `diagnostics.analyzers_enabled` フィールドは、まだ有効なオン／オフスイッチとして機能しません。

## 設定

```toml
[diagnostics]
# 読み込まれたソリューション全体を対象とする C# の起動時スキャン
solution_wide_analysis = true

# C# スキャンを一致するプロジェクト名に限定。空の場合はすべてのプロジェクト
project_filter = []

[analyzers]
# C# と F# 向けの SharpLsp デッドコードアナライザー
dead_code = true

# リポジトリを完全な利用範囲として扱う
monorepo = false
```

通常モードでは、private／internal のデッドコードは警告として報告され、public シンボルは外部 API の可能性があるものとして扱われます。monorepo モードでは、未使用の public シンボルも報告され、重要度はエラーになります。

## 重要度のマッピング

| コンパイラー／アナライザーの重要度 | LSP の重要度 |
|---|---|
| Error | 1 — Error |
| Warning | 2 — Warning |
| Info | 3 — Information |
| Hidden / hint | 4 — Hint |

`server.debounce_ms` フィールドは設定互換性のために受け付けられますが、現在は適用されません。診断リクエストは直ちに開始され、古い結果は世代ゲートによって抑制されます。
