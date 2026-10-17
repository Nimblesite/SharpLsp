---
layout: layouts/blog.njk
title: "VS Code で使える無料の .NET プロファイラー：C# と F# の CPU、メモリ、リーク"
description: "SharpLsp のプロファイラーは、VS Code、Cursor、Windsurf、VSCodium から実行中の任意の .NET プロセスにアタッチします。ホットな行がコード上で光り、隣にフレームグラフが開き、ライブのヒープタイムラインがメモリリークの疑いをランク付けします。MIT ライセンスで、C# と F# に対応します。"
lang: ja
date: 2026-10-17
author: SharpLsp チーム
image: /assets/images/blog/dotnet-profiler-vs-code-csharp-fsharp.png
imageAlt: VS Code の C# コードに表示された SharpLsp プロファイラーのヒートバーと、着実に増え続けリークの可能性として警告されたメモリタイムライン
tags:
  - posts
  - profiling
  - memory-leaks
  - csharp
  - fsharp
category: profiling
excerpt: "アプリが遅い。あるいはメモリが増え続ける。SharpLsp は、実行中の任意の .NET プロセスの CPU とメモリを VS Code から離れずにプロファイリングし、原因となったコード行に答えを表示するようになりました。"
---

どの .NET アプリもいずれ遅くなるか、解放すべきメモリを抱え込むようになります。その原因を突き止めるには、これまでは VS Code を離れる必要がありました。Windows で Visual Studio のプロファイラーを開くか、dotTrace と dotMemory を購入するか、コマンドラインでトレースを記録して別のツールで読むかです。

SharpLsp のプロファイラーは、コードを書いているその場所で仕事をします。実行中の任意の .NET プロセスの CPU とメモリをプロファイリングし、ホットな行とリークの疑いをソースコード上に表示します。MIT ライセンスで、アカウントも不要です。1 分で紹介します。

{% video "profiler-film" %}

## 症状から始める

プロファイラーを使いたくて一日を始める人はいません。始まりは、止まらないファン、4 秒かかるリクエスト、CPU 使用率が高いというアラート、毎晩メモリ不足で落ちるコンテナです。その時点では、どのプロセスが問題なのかもわからず、どの行かなどなおさらです。

だからプロファイラーもそこから始まります。SharpLsp サイドバーの **Processes** ビューは、マシン上のすべての .NET プロセスを PID、ランタイム、ライブの CPU とメモリとともに一覧表示します。コアを使い切っているプロセスや際限なく膨らみ続けるプロセスは、何もプロファイリングしないうちから目に付きます。開いているワークスペースのプロセスはハイライトされます。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-processes.webp" alt="SharpLsp サイドバーの Processes ビュー。実行中の Storefront .NET プロセスと Profile CPU、Track Memory のアクションが表示されている" width="2400" height="1500">
  <figcaption>Processes ビュー：すべての .NET プロセスの PID、ランタイム、CPU、メモリ。</figcaption>
</figure>

行にマウスを合わせて **Profile CPU** または **Track Memory** をクリックします。起動時に問題が出る場合は、**Run & Profile CPU (Current File)** がプロジェクトを SharpLsp デバッガーで起動し、起動時からプロファイリングします。

## CPU プロファイリング：ホットなメソッドだけでなく、ホットな行

この録画は無編集で、実時間です。

{% video "profiler-cpu-recording" %}

サンプラーは、ランタイム自身の診断チャネルである [EventPipe](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/eventpipe) を通じてアタッチします。既定では 100 Hz でサンプリングします。すでに実行中のプロセスに対して動作するため、アプリの再起動も再ビルドもパッケージの追加も不要です。低オーバーヘッドのサンプリングは、Python の py-spy や Java の async-profiler など、他のエコシステムのプロファイラーと同じ方式です。.NET の開発者も、同じものをエディターの中で使えるべきです。

セッションを止めると、結果はコードの上に現れます。ホットな行ごとにサンプルの割合を示すインラインのヒートバーが付き、概要ルーラーがそれぞれに印を付けるので、すぐに移動できます。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-heatmap.webp" alt="インラインのヒートバーが表示された CheckoutPipeline.cs。ParseCatalog 66.8%、PriceBasket 25.1%、RenderInvoice 7.6%" width="2400" height="1500">
  <figcaption>JSON の解析が時間の 3 分の 2 を占めており、その行が正確に示されています。</figcaption>
</figure>

メソッド単位のプロファイラーなら「`Checkout` が遅い」と教えてくれます。ヒートバーは、原因が 17 行目の `JsonSerializer.Deserialize` 呼び出しであり、次に見るべきはバスケットの価格計算だと教えてくれます。

結果パネルはコードの隣に開きます。サンプル数と所要時間、[フレームグラフ](https://www.brendangregg.com/flamegraphs.html)、合計と自己時間の割合を示すホット関数の表が表示されます。フレームグラフでは、各ボックスが 1 つの関数で、その幅が時間の割合です。高いスタックの下にある最も幅の広いボックスが、たいていは見るべき場所です。フレームをクリックするとズームできます。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-flamegraph-zoom.webp" alt="ParseCatalog にズームしたフレームグラフ。System.Text.Json の逆シリアル化スタックが表示されている" width="2400" height="345">
  <figcaption><code>ParseCatalog</code> にズーム：コストは System.Text.Json のデシリアライザーです。</figcaption>
</figure>

<kbd>Ctrl+Alt+P</kbd>（macOS では <kbd>Cmd+Alt+P</kbd>）でどこからでもセッションを開始でき、**Take Profile Snapshot** で停止せずにその時点までの結果を確認できます。

## メモリプロファイリングとリーク検出

.NET のメモリリークのほとんどは、C 言語でいうリークではありません。[ガベージコレクター](https://learn.microsoft.com/ja-jp/dotnet/standard/garbage-collection/fundamentals)は、何からも参照されていないものを解放します。マネージドのリークとは、まだ何かが保持しているオブジェクトのことです。

- 決して削除しない static キャッシュ
- 一度も解除されないイベントハンドラー
- スコープ付きサービスを取り込んだシングルトン。Microsoft はこれを[キャプティブ依存関係](https://learn.microsoft.com/ja-jp/dotnet/core/extensions/dependency-injection/guidelines)と呼んでいます
- クロージャーが所有者を生かし続けるタイマーや `CancellationToken.Register` のコールバック

`Dispose` だけではこれらは直りません。[Dispose](https://learn.microsoft.com/ja-jp/dotnet/standard/garbage-collection/implementing-dispose) はアンマネージドリソースを解放しますが、まだ参照されているオブジェクトは、破棄されていてもいなくてもヒープに残ります。リークを見つけるには、何が増えているかを観察し、何がそれを生かしているかを問うことです。

それを行うのが **Track Memory** です。メモリダッシュボードがコードの隣に開き、アプリの実行中にヒープのスナップショットを取ります。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-memory.webp" alt="着実に増え続けるヒープタイムラインに STEADY GROWTH possible leak と表示されたメモリダッシュボードと、隣の SessionCache.cs" width="2400" height="1500">
  <figcaption>ヒープタイムラインはスナップショットごとに上昇し、ダッシュボードがその着実な増加を指摘します。</figcaption>
</figure>

ダッシュボードには、現在とピークのメモリ、生存オブジェクト数、ヒープタイムライン、上位の割り当て箇所、ランク付けされたリークの疑いが表示されます。スナップショットを取り忘れる心配はありません。デバッガーが一時停止するたびにスナップショットを取って前回と比較し、タイマーで取得することもできます。

疑いは、スナップショットをまたいでどれだけ一貫して増えているかでランク付けされ、バイト数とオブジェクト数の増加量が表示されます。エディターでは、リークしている型の宣言がその行で警告されます。3 倍速です。

{% video "profiler-memory-timelapse" %}

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-leaks.webp" alt="増加量のメガバイトとオブジェクト数とともに HIGH にランク付けされたリークの疑いと、SessionCache.cs の CustomerSession 宣言に表示されたインラインの HIGH リークマーカー" width="2400" height="1500">
  <figcaption>削除されない static の <code>Dictionary</code> が、バイト配列、文字列、それらを保持するセッションの一貫した増加として現れます。</figcaption>
</figure>

続いて **Show Reference Graph** が、疑わしいオブジェクトを生かしているものをルートまでたどって描きます。増加は強い手がかりですが証明ではないため、リークを確定させるのは保持パスです。[メモリリークを修正する](/ja/docs/memory-leaks/)ガイドでは、最初の疑いから検証済みの修正まで、手順を一つずつ説明しています。

## Visual Studio のプロファイラーのワークフローを、Visual Studio の外で

[Visual Studio のプロファイラー](https://learn.microsoft.com/ja-jp/visualstudio/profiling/profiling-feature-tour)や、Rider の [dotTrace](https://www.jetbrains.com/profiler/) と [dotMemory](https://www.jetbrains.com/dotmemory/) を使ったことがあれば、このワークフローはなじみがあるはずです。どれも良いツールですが、プロファイリングを IDE に結び付けています。Visual Studio は Windows でしか動かず、Microsoft は 2024 年に [Visual Studio for Mac を廃止](https://devblogs.microsoft.com/visualstudio/visual-studio-for-mac-retirement-announcement/)しました。dotTrace と dotMemory は商用製品です。

今では多くの .NET 開発者が VS Code やそのフォークでコードを書いています。SharpLsp のプロファイラーは、Windows、macOS、Linux 上の VS Code、Cursor、Windsurf、VSCodium で動作します。エンジンはデバッガー権限を必要としないため、メモリの追跡は macOS でも動作します。

## dotnet-trace、PerfView、BenchmarkDotNet との関係

.NET の診断ツールは優れており、SharpLsp も同じ基盤の上に作られています。エンジンは [dotnet-trace](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/dotnet-trace) と同じ EventPipe チャネルを読みます。違いは、答えがどこに届くかです。

| ツール | 得られるもの | 読む場所 |
|---|---|---|
| [dotnet-counters](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/dotnet-counters) | ライブのランタイムカウンター | ターミナル |
| [dotnet-trace](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/dotnet-trace) | CPU サンプルとイベントの `.nettrace` ファイル | PerfView、Visual Studio、speedscope |
| [dotnet-gcdump](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/dotnet-gcdump) | ヒープのスナップショット | PerfView、Visual Studio |
| [PerfView](https://github.com/microsoft/perfview) | トレースとヒープの詳細な分析 | 専用の Windows アプリ |
| [BenchmarkDotNet](https://benchmarkdotnet.org/) | 1 つのメソッドを単独で測った正確な時間 | レポート |
| SharpLsp プロファイラー | CPU サンプル、ヒープスナップショット、ランク付けされたリークの疑い | エディターの中の、あなたのコード |

結果を共有したり保存したりしたいときには、トレースファイルも役に立ちます。SharpLsp の CPU セッションはどれも、[speedscope](https://www.speedscope.app/) の JSON、VS Code 組み込みのビューアーで開ける `.cpuprofile`、フレームグラフの SVG を `.sharplsp/profiles` に書き出します。

BenchmarkDotNet とプロファイラーは別の問いに答えるので、両方を使いましょう。プロファイラーは実際のアプリでどのメソッドが遅いかを教えてくれます。BenchmarkDotNet は、あなたの変更でそのメソッドが速くなったかを教えてくれます。

## C# と F#、1 つのエンジン

エンジンは言語ではなく .NET ランタイムにアタッチするため、F# にも C# と同じプロファイラーが使えます。F# のプロジェクトでも、同じヒートバー、フレームグラフ、メモリダッシュボード、リークの疑いが得られます。SharpLsp はあらゆる場面で F# を第一級の言語として扱っており、プロファイラーも例外ではありません。

## 試してみる

1. [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) から、または Cursor、Windsurf、VSCodium では [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) から SharpLsp をインストールします。
2. アプリを起動し、SharpLsp ビューを開いて **Processes** の中から見つけます。
3. 遅いなら **Profile CPU** を、メモリが増え続けるなら **Track Memory** をクリックします。

エンジンには .NET 8 以降のランタイムが必要です。`DOTNET_EnableDiagnostics=0` で起動したプロセスにはアタッチできません。すべてのコマンドと設定は[プロファイラーのドキュメント](/ja/docs/profiler/)で説明しています。
