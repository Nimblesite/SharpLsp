---
layout: layouts/docs.njk
title: 診断
description: "SharpLsp の C# と F# の診断：未保存のコードに対する Roslyn と F# Compiler Service のエラー、プッシュとプルの配信、未使用 open とデッドコードのアナライザー。"
lang: ja
---

<img src="/assets/screenshots/docs/diagnostics.webp" alt="問題パネル：未保存の編集から、F# Compiler Service による F# の型エラーと、Roslyn による C# の CS0029 エラー" width="2400" height="1500">

# 診断

SharpLsp は C# と F# の両方についてコンパイラー診断を報告します。C# ファイルは Roslyn が、F# ファイルは F# Compiler Service が処理します。各サイドカーは現在のエディターバッファを解析するため、未保存の変更も含まれます。

{% video "diagnostics" %}

## 配信モデル

VS Code を含む最新のクライアントは、LSP 3.17 のプル診断を使用します。

- **文書プル:** `textDocument/diagnostic` は現在のファイルの診断を取得します。
- **ワークスペースプル:** `workspace/diagnostic` は、開いていないファイルを含む、読み込み済みの F# と C# ソースの診断を取得します。ソリューション全体の解析は既定で有効です。VS Code 拡張機能が結果を要求し、問題パネルに表示します。
- **プッシュへのフォールバック:** プル非対応のクライアントには `textDocument/publishDiagnostics` を送信します。クライアントごとに一つの配信モデルを使うため、同じエラーが重複して表示されません。

未保存の編集、閉じたファイルのディスク上の変更、プロジェクト入力の変更で診断が更新されます。ソリューション全体の解析が有効な間は、ファイルを閉じても実際のエラーは表示されます。解析を無効にすると閉じたファイルの結果が消去され、開いたファイルの診断は引き続き利用できます。

プッシュを使用するクライアントでは、世代ゲートにより古いリクエストが新しい結果を上書きすることを防ぎます。

## 診断ソース

| 言語 | 現在利用できるソース |
|---|---|
| F# | FCS コンパイラー診断に加え、`SLSPF0101`（デッドコード）、`SLSPF0102`（未使用の `open`）、`SLSPF0103`（冗長な修飾子） |
| C# | Roslyn コンパイラー診断、プロジェクトの SDK／NuGet Roslyn アナライザー、SharpLsp のデッドコード診断（`SLSPC0101`） |

Roslyn アナライザーは、評価済みのアナライザー参照、`.editorconfig`、`NoWarn`、ソース内の抑制に従います。`.editorconfig` の規則だけでは、プロジェクトが参照していないアナライザーを読み込みません。`diagnostics.analyzers_enabled` はアナライザー診断を切り替え、コンパイラーエラーは常に表示されます。FSharpLint と FSharp.Analyzers.SDK の統合は現在利用できません。

## 設定

```toml
[diagnostics]
# 開いていない F# と C# ソースもソリューション診断に含める
solution_wide_analysis = true

# プロジェクト名または選択したソリューションからの相対パス。空はすべて
project_filter = []

# コンパイラーエラーを隠さずアナライザー診断を有効にする
analyzers_enabled = true

# 最低の重要度：error、warning、info、hint
min_severity = "hint"

# 重要度で絞り込んだ後のファイルごとの上限。0 は無制限
max_per_file = 0

# ソースやプロジェクトの変更後の更新をまとめる時間（ミリ秒）
refresh_debounce_ms = 2000

# ワークスペースを開く前に不足または古い SDK アセットとパッケージファイルを復元
auto_restore_on_open = true

[analyzers]
# C# と F# 向けの SharpLsp デッドコードアナライザー
dead_code = true

# リポジトリを完全な利用範囲として扱う
monorepo = false
```

プロジェクトフィルターは両言語のワークスペース結果に適用されます。直接の `textDocument/diagnostic` リクエストは除外されません。完全なネイティブプロジェクトパスも指定でき、glob パターンではスラッシュを使用します。

通常モードでは、private／internal のデッドコードは警告として報告され、public シンボルは外部 API の可能性があるものとして扱われます。monorepo モードでは、未使用の public シンボルも報告され、重要度はエラーになります。

## 重要度のマッピング

| コンパイラー／アナライザーの重要度 | LSP の重要度 |
|---|---|
| Error | 1 — Error |
| Warning | 2 — Warning |
| Info | 3 — Information |
| Hidden / hint | 4 — Hint |

`server.debounce_ms` フィールドは設定互換性のために受け付けられますが、現在は適用されません。診断リクエストは直ちに開始され、古い結果は世代ゲートによって抑制されます。
