---
layout: layouts/docs.njk
title: プロファイラー
lang: ja
eleventyExcludeFromCollections: true
---

# プロファイラー

SharpLsp は、VS Code から離れることなく、実行中の任意の .NET プロセスの CPU とメモリをプロファイリングします。ホットな行はコード上で直接ハイライトされ、隣にフレームグラフとホット関数の表が表示され、ライブのヒープタイムラインがアプリの実行中にリークの疑いをランク付けします。`dotnet-trace` のインストールもダンプもライセンスも不要です。

{% video "profiler-csharp" %}

## しくみ

プロファイラーはどちらの言語サイドカーでもなく SharpLsp ホストの中で動作するため、サイドカーが再起動してもセッションは終了しません。拡張機能は `sharplsp` バイナリの隣に小さな .NET エンジンを同梱しており、ランタイムの診断チャネル（EventPipe）を通じて対象にアタッチします。

- CPU サンプリングもヒープスナップショットも、すでに実行中のプロセスに対して動作します。
- アプリを再起動したり再ビルドしたりする必要はありません。
- エンジンはデバッガー権限を必要としないため、メモリプロファイラーは macOS でも動作します。

エンジンには .NET 8 以降のランタイムが必要です。`DOTNET_EnableDiagnostics=0` で起動したプロセスにはアタッチできません。

## プロセス

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-processes.webp" alt="SharpLsp サイドバーの Processes ビュー。実行中の Storefront .NET プロセスと Profile CPU、Track Memory のアクションが表示されている" width="2400" height="1500">
  <figcaption>Processes ビューは各 .NET プロセスの PID、ランタイム、CPU、メモリを一覧表示します。開いているワークスペースのプロセスはハイライトされます。</figcaption>
</figure>

SharpLsp サイドバーの **Processes** ビューは、マシン上の .NET プロセスを検出します。各行には PID、ランタイムのバージョン、CPU 使用率、メモリが表示され、開いているワークスペースのプロセスはハイライトされます。行にマウスを合わせるとインラインのアクションが表示されます。

- **Profile CPU** はサンプラーをアタッチします。
- **Track Memory** はヒープの追跡を開始します。

行のコンテキストメニューには **Copy PID**、**Reveal Entry in Editor**、**Kill Process** もあります。ビューのツールバーには、さらに 3 つの入り口があります。

- **Run & Profile CPU (Current File)** と **Run & Track Memory (Current File)** は、現在のプロジェクトを SharpLsp デバッガーで起動し、起動時からプロファイリングします。
- **Refresh**、**Sort**、**Group**、**Filter** でプロセス一覧を整理できます。

## CPU プロファイリング

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-live.webp" alt="進行中の CPU プロファイリングセッション。Processes ビューに Profiling PID、ステータスバーに Profiling と表示されている" width="2400" height="1500">
  <figcaption>進行中のセッション。ステータスバーの項目をクリックすると停止します。</figcaption>
</figure>

行の **Profile CPU** をクリックするか、**SharpLsp: Start Profiling**（<kbd>Ctrl+Alt+P</kbd>、macOS では <kbd>Cmd+Alt+P</kbd>）を実行します。アプリに遅い処理を通らせてから、**SharpLsp: Stop Profiling**（<kbd>Ctrl+Alt+Shift+P</kbd>、macOS では <kbd>Cmd+Alt+Shift+P</kbd>）を実行するか、ステータスバーの項目をクリックします。**SharpLsp: Take Profile Snapshot** を使うと、停止せずにその時点の結果を確認できます。

セッションが停止すると、結果が 2 か所に同時に表示されます。

**エディター内。** ホットな行にはそれぞれ、サンプルの割合を示すインラインのヒートバーが表示されます。バーは強度に応じてオレンジから琥珀色になり、概要ルーラーにも各ホットな行が表示されるので、すぐに移動できます。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-heatmap.webp" alt="インラインのヒートバーが表示された CheckoutPipeline.cs：ParseCatalog 66.8%、PriceBasket 25.1%、RenderInvoice 7.6%" width="2400" height="1500">
  <figcaption>ヒートマップは、JSON の解析が時間の 3 分の 2 を占めていることを、該当する行まで特定して示しています。</figcaption>
</figure>

**結果パネル内。** サンプル数、所要時間、関数の数、ホットな行の数が表示され、その下にフレームグラフと、合計とセルフの割合を含むホット関数の表が続きます。行をクリックすると、そのソースの位置が開きます。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-results.webp" alt="SharpLsp Profiler の結果パネル。概要カード、埋め込みのフレームグラフ、ホット関数の表" width="2400" height="1500">
  <figcaption>結果パネル。閉じた後は <strong>SharpLsp: Show Profile Results</strong> で再び開けます。</figcaption>
</figure>

**Open Interactive Flame Graph** を使うと、フレームグラフ全体が開きます。フレームをクリックすると、そのサブツリーにズームします。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-flamegraph.webp" alt="プロファイル全体のインタラクティブなフレームグラフ" width="2400" height="345">
  <figcaption>プロファイル全体。</figcaption>
</figure>

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-flamegraph-zoom.webp" alt="ParseCatalog にズームしたフレームグラフ。System.Text.Json の逆シリアル化のスタックが表示されている" width="2400" height="345">
  <figcaption><code>ParseCatalog</code> にズーム：コストは System.Text.Json のデシリアライザーにあります。</figcaption>
</figure>

各セッションは `.sharplsp/profiles` に 3 種類のエクスポートも書き出します。

- speedscope 形式の JSON
- VS Code の組み込みプロファイルビューアーで開ける `.cpuprofile`
- フレームグラフの SVG

{% video "profiler-cpu-recording" %}

## メモリ追跡

行の **Track Memory** をクリックするか、**SharpLsp: Start Memory Tracking** を実行します。コードの隣に **SharpLsp Memory Dashboard** が開き、次の内容が表示されます。

- 現在とピークのメモリ、生存オブジェクト数
- ヒープのタイムライン
- 主な割り当て箇所
- ランク付けされたリークの疑い

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-memory.webp" alt="着実に上昇するヒープタイムラインに STEADY GROWTH possible leak と表示されたメモリダッシュボードと、隣の SessionCache.cs" width="2400" height="1500">
  <figcaption>スナップショットのたびにタイムラインが上昇し、着実な増加がグラフ上で指摘されます。</figcaption>
</figure>

メモリのオートパイロットが、スナップショットの取得と比較を代わりに行います。

- デバッガーが一時停止するたびに（`sharplsp.profiler.autoSnapshotOnPause`、既定で有効）
- プログラムの実行中、数秒ごとに（`sharplsp.profiler.autoSnapshot`）

**Take Memory Snapshot**、**Compare Memory Snapshots**、**Force Garbage Collection** を使えば、スナップショットを手動で操作することもできます。

リークの疑いは、増加がどれだけ一貫しているかでランク付けされます。各項目には、バイト数とオブジェクト数での増加量と、連続して増加したスナップショットの回数が表示されます。エディターでは、メモリを割り当てる各型の宣言に紫色のヒートバーが表示され、リークの疑いも同じ行に示されます。ダッシュボードの **Heat map mode** で、エディターの表示をメモリ（紫）と CPU（オレンジ）の間で切り替えられます。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-leaks.webp" alt="MB 単位の増加量とオブジェクト数とともに HIGH とランク付けされたリークの疑いと、SessionCache.cs の CustomerSession 宣言に表示されたインラインの HIGH リークマーカー" width="2400" height="1500">
  <figcaption>リークの疑い。エントリを削除しない静的な <code>Dictionary</code> が、バイト配列、文字列、それらを保持するセッションの一貫した増加として現れています。</figcaption>
</figure>

**SharpLsp: Show Reference Graph** は、ある型の保持グラフを描画します。その型を保持しているオブジェクトと、それらを生かし続けているルートが表示されます。ヒープの増加はヒューリスティックであり、リークの証明ではありません。疑わしい項目は、保持パスとアプリの動作で確認してください。

{% video "profiler-memory-timelapse" %}

## F#

F# のプログラムにも同じプロファイラーが使え、F# コンパイラーが生成するコードを読み解きます。クロージャーとパイプラインのステージは、`Pipe #1 stage #1 at line 11` のようにコンパイラーが付けた名前のまま表示されます。レコード、共用体、共用体ケースは、それを組み立てる行に塗られます。モジュール値が保持するリークは、その値をソースに書いたとおりの名前で示します。[F# のプロファイリング](/ja/docs/fsharp-profiling/)では、F# アプリでの一連の流れを動画で紹介しています。

## コマンド

| コマンド | 用途 |
|---|---|
| `SharpLsp: Profile CPU` / `Track Memory` | 選択した行のプロセスをプロファイリング |
| `SharpLsp: Run & Profile CPU (Current File)` / `Run & Track Memory (Current File)` | 現在のプロジェクトを起動し、最初からプロファイリング |
| `SharpLsp: Start Profiling` / `Stop Profiling` | CPU セッションの開始と停止 |
| `SharpLsp: Take Profile Snapshot` | 停止せずにその時点の結果を確認 |
| `SharpLsp: Show Profile Results` | 前回の結果パネルを再表示 |
| `SharpLsp: Start Memory Tracking` / `Stop Memory Tracking` | ヒープ追跡の開始と停止 |
| `SharpLsp: Take Memory Snapshot` / `Compare Memory Snapshots` | ヒープスナップショットの取得と比較 |
| `SharpLsp: Force Garbage Collection` | スナップショットの前にガベージコレクションを実行 |
| `SharpLsp: Show Reference Graph` | ある型を生かし続けているものを表示 |
| `SharpLsp: Refresh Processes` / `Sort Processes` / `Group Processes` / `Filter Processes` | プロセス一覧の整理 |
| `SharpLsp: Copy PID` / `Reveal Entry in Editor` / `Kill Process` | プロセス行のアクション |

## 設定

| 設定 | 既定値 | 用途 |
|---|---|---|
| `sharplsp.profiler.sampleRate` | `100` | CPU のサンプリングレート（Hz、1〜1000） |
| `sharplsp.profiler.lineThreshold` | `1` | ホットな行とみなすサンプルの最小割合（%） |
| `sharplsp.profiler.functionThreshold` | `2` | ホットな関数とみなすサンプルの最小割合（%） |
| `sharplsp.profiler.showInlineHeatMap` | `true` | プロファイリング後にホットな行へヒートバーを表示 |
| `sharplsp.profiler.maxDiagnosticsPerFile` | `20` | ファイルごとのプロファイリングマーカーの上限 |
| `sharplsp.profiler.includeNative` | `false` | 結果にネイティブフレームを含める |
| `sharplsp.profiler.profileOnLaunch` | `false` | SharpLsp のデバッグセッションの開始時に毎回プロファイリング |
| `sharplsp.profiler.processRefreshMs` | `2000` | Processes ビューの更新間隔 |
| `sharplsp.profiler.autoSnapshotOnPause` | `true` | デバッガーが一時停止するたびにスナップショットを取得して比較 |
| `sharplsp.profiler.autoSnapshot` | `false` | メモリ追跡中に一定間隔でスナップショットを取得 |
| `sharplsp.profiler.autoSnapshotInterval` | `30` | 定期スナップショットの間隔（秒） |

`sharplsp.toml` の `[profiler]` テーブルで、出力ディレクトリ（既定は `.sharplsp/profiles`）とホットスポットのしきい値を設定します。[構成](/ja/docs/configuration/)を参照してください。
