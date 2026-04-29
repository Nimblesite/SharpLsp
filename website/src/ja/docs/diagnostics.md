---
layout: layouts/docs.njk
title: 診断
lang: ja
eleventyExcludeFromCollections: true
---

![VS Code での診断](/assets/screenshots/vscode-diagnostics-page.png)

*Alpha 版 VS Code 拡張機能での Roslyn 診断。*

# 診断

SharpLsp は C# コンパイラーエラー、警告、Roslyn アナライザー診断を C# サイドカー経由でルーティングします。現在のサイトは VS Code 拡張機能の状態を示しています。F# 診断はまだ開発中です。

## 仕組み

```
エディター ←→ Rust LSP ホスト ←→ C# サイドカー
  ↑              ↑                  ↑
Problems     publishDiagnostics    Roslyn
ビュー        通知                 GetDiagnostics()
```

1. **文書変更** — エディターが `textDocument/didChange` を送信し、Rust ホストが VFS と tree-sitter を更新します
2. **debounce** — 変更は 150ms のウィンドウでまとめられます（設定可能）
3. **ディスパッチ** — Rust ホストが C# サイドカーへ `workspace/diagnostics` リクエストを送ります
4. **解析** — Roslyn が影響範囲に対して完全なセマンティック解析を実行します
5. **公開** — 結果が LSP `Diagnostic` オブジェクトへマップされ、エディターへ push されます

> **注:** 診断は現在 C# のみです。FCS による F# 診断はまだ実装されていません。

## 解析範囲

| モード | 既定値 | 説明 |
|--------|--------|------|
| **ソリューション全体** | ✓ | 読み込まれた全プロジェクト内の全ドキュメント |
| 開いているファイルのみ | ✗ | 現在エディターで開いているドキュメントのみ |
| プロジェクトフィルター | ✗ | 名前パターンに一致する特定プロジェクト |

ソリューション全体解析は SharpLsp の方向性の一部です。Alpha 版拡張機能はまだ強化中のため、診断の挙動は beta 安定性の保証ではなく、開発中の機能として扱ってください。

## 診断カテゴリ

### コンパイラー診断

| 言語 | 例 |
|------|----|
| C#（Roslyn） | `CS0029`（型変換）、`CS0246`（型が見つからない）、`CS8600`–`CS8798`（nullable） |

### アナライザー診断

- **組み込み Roslyn アナライザー** — IDE0001–IDE0090、CA1000–CA2000 のコード品質ルール
- **.editorconfig ルール** — `.editorconfig` の重要度からマップされるコードスタイル強制
- **サードパーティ NuGet アナライザー** — StyleCop、SonarAnalyzer、および任意の `<Analyzer>` 参照

### ライブ波線

診断は次の場合に push されます。

- **文書変更時** — debounce ウィンドウ後に再解析
- **プロジェクト変更時** — `.csproj` / `.fsproj` 変更時に再解析
- **ソリューション読み込み時** — 完全なソリューションスキャンをインクリメンタルにストリーミング

## 設定

```toml
# sharplsp.toml
[diagnostics]
# Roslyn アナライザーを実行（コンパイラーエラーだけではない）
analyzers_enabled = true

# 開いているファイルだけでなく、ソリューション内の全ファイルを解析
solution_wide_analysis = true

# 特定プロジェクト名に解析を制限（空 = すべて）
project_filter = []
```

### プロジェクトフィルター

大きな monorepo では範囲を絞れます。

```toml
[diagnostics]
project_filter = ["MyApp.Core", "MyApp.Api"]
```

## パフォーマンス目標

| 指標 | 目標 |
|------|------|
| 単一ファイル更新 | キー入力から <500ms |
| ソリューション全体の初回スキャン | 50 プロジェクトのソリューションで <10s |
| インクリメンタル再解析 | 単一ファイル編集後 <1s |
| メモリオーバーヘッド（ソリューション全体） | 50 プロジェクトで <200MB |

## 重要度マッピング

| Roslyn / FCS 重要度 | LSP 重要度 |
|---------------------|------------|
| Error | 1 — Error |
| Warning | 2 — Warning |
| Info | 3 — Information |
| Hidden | 4 — Hint |
