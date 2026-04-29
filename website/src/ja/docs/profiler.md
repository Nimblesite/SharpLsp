---
layout: layouts/docs.njk
title: プロファイラー
lang: ja
eleventyExcludeFromCollections: true
---

![VS Code でのプロファイラー](/assets/screenshots/vscode-profiler-page.png)

*Alpha 版 VS Code 拡張機能で公開されているプロファイラーワークフロー。*

# プロファイラー

SharpLsp は .NET 診断ワークフローを VS Code に統合します。拡張機能は、プロセス検出、トレース、カウンター、ダンプ、ヒープ解析、関連ファイル操作のコマンドを公開します。プロファイラー体験は beta に向けて強化中です。

## 前提条件

.NET 診断ツールをグローバルにインストールします。

```bash
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

SharpLsp は PATH と `dotnet tool list -g` からこれらのツールを自動検出します。ツールが見つからない場合、コマンドはインストールコマンドを含む実行可能なエラーを返します。

## プロファイラーツリービュー

SharpLsp サイドバーの **Profiler** パネルには次が表示されます。

| セクション | 内容 |
|------------|------|
| **Active Sessions** | 実行中のトレースとカウンターモニター（セッション ID 付き） |
| **.NET Processes** | 検出可能なプロセス（PID とコマンドライン付き） |

**Refresh** をクリックするとプロセス一覧が更新されます。ステータスバーにはアクティブなプロファイルセッション数が表示されます。

## パフォーマンストレース（dotnet-trace）

詳細なパフォーマンストレースを取得し、SpeedScope で表示します。

### トレースを開始する

1. SharpLsp サイドバーで **Profiler** ビューを開きます
2. コマンドパレットから `SharpLsp: Start Trace` を実行します
3. ピッカーから .NET プロセスを選びます
4. トレースセッションがツリービューに表示されます

### トレースを停止する

1. コマンドパレットから `SharpLsp: Stop Trace` を実行します
2. アクティブなトレースセッションを選びます
3. SharpLsp が `.nettrace` を SpeedScope 形式へ変換し、ブラウザーで自動的に開きます

### 設定

```toml
# sharplsp.toml
[profiler]
default_profile = "cpu-sampling"   # cpu-sampling | gc-verbose | gc-collect | none
default_format = "speedscope"      # speedscope | nettrace | chromium
default_duration = 0               # 秒。0 = 手動停止
max_sessions = 5
```

## ライブカウンター監視（dotnet-counters）

リアルタイム更新されるテーブルで .NET パフォーマンスカウンターを監視します。

### 監視を開始する

1. コマンドパレットから `SharpLsp: Start Counters` を実行します
2. .NET プロセスを選びます
3. ライブカウンター値を表示する webview パネルが開きます

### カウンター表示

| 列 | 内容 |
|----|------|
| **Provider** | カウンタープロバイダー（例: `System.Runtime`） |
| **Counter** | カウンター表示名 |
| **Value** | 現在値（バイト、件数、パーセンテージなどに整形） |
| **Unit** | 測定単位 |

カウンターは `sharplsp/profiler/counterUpdate` LSP 通知でストリーミングされます。`SharpLsp: Stop Counters` を実行するとセッションが終了します。

## メモリダンプ（dotnet-dump）

メモリリークや高メモリ使用量を調べるため、メモリダンプを取得して解析します。

### ダンプを収集する

1. コマンドパレットから `SharpLsp: Collect Dump` を実行します
2. .NET プロセスを選びます
3. ダンプ種別を選びます: **Heap**、**Full**、**Mini**
4. SharpLsp が出力パスとファイルサイズを報告します

### ヒープを解析する

1. コマンドパレットから `SharpLsp: Analyze Heap` を実行します
2. `.dmp` ファイルを選びます
3. SharpLsp が `dumpheap -stat` を実行し、整形されたテーブルを表示します

| 列 | 内容 |
|----|------|
| **Type Name** | 完全修飾 .NET 型 |
| **Count** | ヒープ上のインスタンス数 |
| **Total Size** | 合計サイズ（B/KB/MB に整形） |

## ヒープスナップショットの差分

2 つのヒープダンプを比較して、増加している型やメモリリークを特定します。

### スナップショットを比較する

1. コマンドパレットから `SharpLsp: Compare Heap Snapshots` を実行します
2. **baseline** ダンプファイルを選びます（疑わしいリーク経路を実行する前）
3. **comparison** ダンプファイルを選びます（実行後）
4. 差分パネルが開き、次を表示します

| 列 | 内容 |
|----|------|
| **Type** | .NET 型名 |
| **Baseline Count / Current Count** | 前後のインスタンス数 |
| **Count Delta** | 件数の変化（+/-） |
| **Baseline Size / Current Size** | メモリサイズ |
| **Size Delta** | メモリ変化（+/-） |
| **Growth %** | 増加率 |

任意の行をクリックすると、comparison ダンプ内のその型に対する Object Retention Graph が開きます。

### リーク候補テーブル

完全な差分の上に、SharpLsp は重大度で自動分類した **leak suspects** を表示します。

| 重大度 | 条件 |
|--------|------|
| **High** | 件数が >100% 増加、かつサイズ差分 >1 MB |
| **Medium** | 件数が >50% 増加、かつサイズ差分 >100 KB |
| **Low** | 件数が >10% 増加、かつサイズ差分 >10 KB |

リークしやすい既知の型（`EventHandler`、`CancellationTokenSource`、`Timer`、delegate）は最低でも Low へ引き上げられます。増加するコレクション（`List`、`Dictionary`、配列）は、上限のない蓄積の可能性としてフラグ付けされます。

## 自動リーク検出

baseline → exercise → compare のガイド付きワークフローを自動実行します。

1. `SharpLsp: Detect Memory Leaks` を実行します
2. .NET プロセスを選びます。SharpLsp が baseline ダンプを収集します
3. アプリケーションで疑わしいリーク経路を実行します
4. SharpLsp が comparison ダンプを収集し、完全なヒープ差分を自動実行します
5. 差分パネルが開き、候補が強調表示されます

## Object Retention Graph

ダンプ内で生存しているオブジェクトと、それをメモリ上に保持しているものを可視化します。

### グラフを開く

1. コマンドパレットから `SharpLsp: Show Object Retention Graph` を実行します
2. `.dmp` ファイルを選びます
3. ルートオブジェクトアドレスを入力します（16 進数、例: `00007ff812345678`）
4. 対話型の force-directed graph が webview パネルに描画されます

または、Heap Diff パネルの任意の行をクリックすると、comparison ダンプをプリロードした状態でグラフが開きます。

### グラフ操作

| 操作 | 内容 |
|------|------|
| **Filter by type** | テキスト入力。型名に一致しないノードを隠します |
| **Depth slider** | ルートから N 階層以内のノードに表示を制限します |
| **Export SVG** | 現在のグラフを SVG として出力します |
| **Hover tooltip** | 型、アドレス、サイズ、保持サイズ、インスタンス数を表示します |

### ノード色

| 色 | 意味 |
|----|------|
| 赤 | リーク候補、または保持サイズが大きい GC root |
| オレンジ | 保持サイズが大きい（>1 MB） |
| 青 | GC root（static field、thread stack、pinned、finalizer） |
| 灰色 | 通常オブジェクト |

破線枠 = GC root。破線エッジ = weak reference。

### オブジェクト調査

1. コマンドパレットから `SharpLsp: Inspect Object` を実行します
2. `.dmp` ファイルを選び、オブジェクトアドレスを入力します
3. テキストパネルに、オブジェクトの型、サイズ、世代、参照アドレス付きの全フィールド値が表示されます

## コマンド

| コマンド | 説明 |
|----------|------|
| `SharpLsp: Refresh Profiler` | .NET プロセス一覧を更新 |
| `SharpLsp: List Processes` | .NET プロセスを更新して表示 |
| `SharpLsp: Start Trace` | .NET プロセスのパフォーマンストレースを開始 |
| `SharpLsp: Stop Trace` | アクティブなトレースを停止して SpeedScope で開く |
| `SharpLsp: Start Counters` | ライブカウンター監視を開始 |
| `SharpLsp: Stop Counters` | カウンター監視を停止 |
| `SharpLsp: Collect Dump` | メモリダンプを取得 |
| `SharpLsp: Analyze Heap` | ダンプファイルからヒープ統計を解析 |
| `SharpLsp: Compare Heap Snapshots` | 2 つのヒープダンプを比較し、増加型を探す |
| `SharpLsp: Detect Memory Leaks` | baseline → exercise → compare のガイド付きワークフロー |
| `SharpLsp: Show Object Retention Graph` | 対話型オブジェクト参照グラフ |
| `SharpLsp: Inspect Object` | 単一オブジェクトのフィールドと参照を調査 |

## パフォーマンス目標

| 操作 | 目標 |
|------|------|
| プロセス一覧更新 | <500ms |
| トレース開始レイテンシ | <1s |
| カウンター更新配信 | ツール出力からエディターまで <100ms |
| ヒープ解析（50k+ 型） | <5s |
| GC root traversal | <10s |
| オブジェクトグラフ（深さ 3、200 ノード） | <3s |
| オブジェクトグラフ（深さ 5、200 ノード） | <8s |
