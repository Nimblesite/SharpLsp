# SharpLsp for VS Code

オープンソースの .NET Language Server — あらゆるエディターのための C# / F# インテリジェンス。ライセンス料ゼロ、ベンダーロックインなし。

> 🌐 **他の言語:** [English](https://sharplsp.dev/) · [简体中文](https://sharplsp.dev/zh/)

## 機能

- **コード補完** — Roslyn による IntelliSense 品質の補完
- **診断** — 入力に追従するリアルタイムのエラーと警告
- **ホバー / クイック情報** — 完全な型シグネチャ、XML ドキュメント、nullable 注釈
- **定義へ移動** — ソースまたは逆コンパイルされたメタデータへジャンプ
- **ドキュメントシンボル** — tree-sitter による高速アウトライン
- **コード折りたたみ** — 構文を考慮した領域の折りたたみ
- **F# サポート** — FSharp.Compiler.Service による第一級の F# 対応
- **ソリューションエクスプローラー** — .sln / .slnx、プロジェクト、シンボルのツリービュー
- **プロファイラー** — 組み込みの .NET プロファイリング、カウンター監視、メモリ解析

## プロファイラー

SharpLsp は `dotnet-trace`、`dotnet-counters`、`dotnet-dump` をシームレスなエディター体験にラップします。ターミナルは不要です。

### セットアップ

.NET 診断ツールをインストールします:

```bash
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

### 使い方

SharpLsp サイドバーの **Profiler** パネルを開くと、実行中の .NET プロセスを確認できます。

| 操作 | 方法 |
|--------|-----|
| **パフォーマンスをトレース** | `SharpLsp: Start Trace` — プロセスを選択すると、停止するまでトレースが実行されます。出力は SpeedScope で開きます。 |
| **カウンターを監視** | `SharpLsp: Start Counters` — webview パネルで .NET パフォーマンスカウンターをリアルタイム更新するテーブルを表示します。 |
| **メモリダンプを取得** | `SharpLsp: Collect Dump` — Heap、Full、Mini のいずれかのダンプ種別を選択します。 |
| **ヒープを解析** | `SharpLsp: Analyze Heap` — `.dmp` ファイルを選択して、型ごとの件数とメモリ使用量を表示します。 |

すべてのコマンドはコマンドパレット（`Ctrl+Shift+P` / `Cmd+Shift+P`）から利用できます。

## 必要環境

- .NET SDK 10.0+
- `sharplsp` バイナリ（ソースからビルドするか、リリースからダウンロード）

## 構成

ワークスペースルートの `sharplsp.toml` で構成します。詳細は[完全なドキュメント](https://sharplsp.dev/ja/docs/configuration/)を参照してください。

## リンク

- [ドキュメント](https://sharplsp.dev/ja/docs/)
- [GitHub](https://github.com/Nimblesite/SharpLsp)
- [Issues](https://github.com/Nimblesite/SharpLsp/issues)
