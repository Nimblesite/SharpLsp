---
layout: layouts/blog.njk
title: "アプリが遅いとき、メモリがリークしているとき、.NET 開発者は何を検索するのか"
description: ".NET のプロファイリング、CPU、メモリ、メモリリーク検出に関する 5 年分の Google Trends データ。アプリが遅いときに開発者が何を入力し、どのツールの名前を挙げるのか、そして SharpLsp のプロファイラーが VS Code でそれぞれの検索にどう応えるのか。"
lang: ja
date: 2026-10-17
author: SharpLsp チーム
image: /assets/images/blog/dotnet-profiler-memory-leak-search-trends.png
imageAlt: high cpu usage が cpu profiler の 15 倍検索されていることを示す Google Trends の棒グラフと、VS Code の C# コードに表示された SharpLsp のヒートマップ
tags:
  - posts
  - profiling
  - memory-leaks
  - csharp
  - fsharp
category: profiling
excerpt: "「high cpu usage」は「cpu profiler」の 15 倍、「c# dispose」は「c# memory leak」の 7 倍検索されています。.NET のプロファイリングとメモリリークに関する 5 年分の Google Trends を読み、SharpLsp がそれぞれの検索にどこで応えるかを確かめました。"
---

.NET のプロファイリング、CPU、メモリ、メモリリーク検出に関する 5 年分の Google Trends データを読みました。アプリが遅いとき、メモリが上がり続けるとき、開発者が何を入力し、どのツールの名前を挙げるのかを知りたかったのです。結論を先に言うと、**人はツールではなく症状を検索します**。そして、VS Code から検索する人が増えています。

この記事では、データが示すことと、SharpLsp のプロファイラーがそれぞれの検索にどう応えるかを順に見ていきます。まずは 1 分でプロファイラーを紹介します。

{% video "profiler-film" %}

## 測定方法

Google Trends を使いました。全世界のウェブ検索、週単位、2021 年 10 月から 2026 年 10 月までです。検索語を 5 つずつ比較し、各語の人気と急上昇の関連キーワードを読みました。

Trends の値は相対値です。100 は*その比較の中で*最も多く検索された語の最も多い週を表すため、数字は同じ表のほかの数字と並べたときにだけ意味を持ちます。年ごとの数字は週ごとの値の平均です。2021 年は最後の 11 週だけ、2026 年は 10 月中旬までです。Google の検索量の下限に満たない語は 0 になります。

2026 年には多くの語が上昇しました。同じ比較の中のほかの語、たとえば「visual studio profiler」や「high cpu usage」は横ばいか下降だったので、この上昇は Google のデータ全体のずれではありません。

## 1. 人はツールではなく症状を検索する

| 検索語 | 5 年間の平均 |
|---|---:|
| high cpu usage | 53.2 |
| performance profiler | 6.0 |
| flame graph | 5.5 |
| cpu profiler | 3.5 |
| cpu profiling | 2.5 |

「high cpu usage」は「cpu profiler」の 15 倍検索されています。検索しているのは主に Windows ユーザーとゲーマーで、人気の関連キーワードは Windows 11、Chrome、マルウェア対策に関するものです。それでも開発者の出発点は同じです。何かが遅いのに、それが何かはまだわからないのです。

メモリも同じです。別の比較では、「memory leak」の平均が 21.0、「memory profiling」が 1.4 で、やはり 15 対 1 です。最も大きな意図は修正です。「fix memory leak」は 2024 年の 10.2 から 2026 年の 24.2 に上がり、「how to fix memory leak」は 3 倍以上になりました。その多くは Minecraft のプレイヤーによるものですが、「how to fix a memory leak」が Mod の名前のすぐ後に続いています。

だから SharpLsp のプロファイラーは症状から始まります。**Processes** ビューにはマシン上のすべての .NET プロセスがリアルタイムの CPU とメモリとともに並ぶので、何かをプロファイルする前に、コアを使い切っているプロセスや際限なく増えているプロセスが見えます。その行にカーソルを合わせて **Profile CPU** をクリックします。この録画は無編集・実時間です。

{% video "profiler-cpu-recording" %}

ホットな行がサンプルに占める割合とともにコードの中で光ります。メソッドだけでなく、行そのものが見えます。

## 2. .NET のプロファイリングの検索は伸びている

| 年 | .net profiler | java profiler | python profiler | go pprof |
|---|---:|---:|---:|---:|
| 2022 | 7.7 | 32.0 | 42.8 | 15.8 |
| 2023 | 6.6 | 30.3 | 44.7 | 17.4 |
| 2024 | 4.9 | 31.1 | 44.8 | 21.8 |
| 2025 | 8.9 | 26.4 | 42.9 | 20.7 |
| 2026 | 11.8 | 27.6 | 57.6 | 33.2 |

「.net profiler」は 4 つの中で最も小さいものの、2022 年から 5 割増えました。一方で Java のプロファイラーの検索は減っています。「.net performance」と「c# performance」はどちらも 2025 年から 2026 年にかけてほぼ倍増し、それぞれ 15.6 から 29.6、15.3 から 28.7 になりました。急上昇の関連キーワードにはリリース名が並びます。「.net 10」「performance improvements in .net 8」「.net aspire」。ランタイムは毎年速くなり、そのあとで開発者は自分のコードの遅い部分を探したくなるのです。

ほかのエコシステムを見ると、いま求められているプロファイラーの姿がわかります。Python で急上昇したプロファイラーの検索は memray、Scalene、py-spy（+800%）です。Java では async-profiler（+2,000%）です。どれも実行中のプロセスにアタッチしてフレームグラフを描く、オーバーヘッドの小さいサンプリングプロファイラーです。「flame graph」自体も 2025 年の 5.6 から 2026 年の 13.9 に、「cpu profiler」は 2.5 から 11.2 に上がりました。

これがまさに SharpLsp のプロファイラーの形です。ランタイム自身の診断チャネルを通じて 100 Hz でサンプリングし、すでに実行中のプロセスにアタッチし、再起動も再ビルドも必要ありません。結果パネルからはズームできるフレームグラフが開きます。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-flamegraph-zoom.webp" alt="ParseCatalog にズームしたフレームグラフ。System.Text.Json の逆シリアル化のスタックが表示されている" width="2400" height="345">
  <figcaption><code>ParseCatalog</code> にズーム：コストは System.Text.Json のデシリアライザーにあります。</figcaption>
</figure>

## 3. まずメモリ

「.net profiler」を検索すると、関連キーワードの先頭にはメモリが来ます。

| 関連キーワード | 相対的な関心度 |
|---|---:|
| memory profiler | 100 |
| .net memory profiler | 99 |
| visual studio profiler | 63 |
| .net performance profiler | 60 |
| c# profiler | 44 |

メモリの比較では、「memory profiler」が 2025 年の 32.8 から 2026 年の 47.7 に上がり、「memory leak detection」は 9.8 から 27.3 へとほぼ 3 倍になりました。

## 4. C# の開発者は仕組みを検索する

| 検索語 | 5 年間の平均 |
|---|---:|
| c# performance | 14.7 |
| .net performance | 10.6 |
| c# dispose | 5.9 |
| c# garbage collection | 1.7 |
| c# memory leak | 0.8 |

「c# dispose」は「c# memory leak」の 7 倍検索されています。リークそのものの関連キーワードは「visual studio memory leak」「c# dispose」「what is memory leak」（+170%）です。`Dispose` の周りで急上昇しているのは「c# using statement」（+120%）と「dependency injection c#」（+90%）。ガベージコレクションの周りでは「.net core」（+190%）と面接の質問です。

これはマネージドコードでのリークの実態と一致します。ガベージコレクターは何からも参照されていないものをすべて解放するので、.NET のリークとは何かがまだ保持しているオブジェクトです。削除しない静的キャッシュ、外さないイベントハンドラー、scoped のサービスを捕捉したシングルトン。`Dispose` はアンマネージドリソースを解放しますが、参照されているオブジェクトを回収可能にはしません。リークを見つけるには、何が増えているかを観察し、何がそれを生かし続けているのかを問うことです。

それを行うのが **Track Memory** です。メモリダッシュボードがコードの横に開き、アプリの実行中にヒープのスナップショットを撮ります。増加の一貫性でリークの疑いを順位付けし、リークしている型の宣言をエディターで示します。3 倍速です。

{% video "profiler-memory-timelapse" %}

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-leaks.webp" alt="MB 単位の増加量とオブジェクト数とともに HIGH とランク付けされたリークの疑いと、SessionCache.cs の CustomerSession 宣言に表示されたインラインの HIGH リークマーカー" width="2400" height="1500">
  <figcaption>リークの疑い。エントリを削除しない静的な <code>Dictionary</code> が、バイト配列、文字列、それらを保持するセッションの一貫した増加として現れています。</figcaption>
</figure>

続いて **Show Reference Graph** が、疑いを生かし続けているものをルートまでさかのぼって描きます。「fix memory leak」が最も多く検索されているので、2 本書きました。[メモリリークの修正](/ja/docs/memory-leaks/)ガイドは流れを順を追って説明し、[C# と .NET のメモリリークを修正する方法](/ja/blog/how-to-fix-a-memory-leak-in-csharp-dotnet/)は、実際のリークを最初の疑いから修正の確認まで追いかけます。

## 5. 名前の挙がるツールは IDE に属している

最大のプロファイラーの検索語は「visual studio profiler」です。平均は 15.2 で、5 年間横ばいでした。「.net memory profiler」は「visual studio memory profiler」につながり、「visual studio performance profiler」は急上昇中です（+250%）。

JetBrains の関連検索は Rider に関するものです。「rider」は dotTrace（+140%）と dotMemory（+130%）の両方で急上昇の関連キーワードのトップです。dotTrace の関心度は 2023 年に 14.6 でピークを迎え、2026 年には 5.6 まで下がり、この年 PerfView に抜かれました。dotMemory の急上昇した関連検索のうち 2 つは、アクティベーションコードと改造版を探すものです。人が欲しいのはライセンスではなくツールです。

その間に、エディターが移りました。

| 年 | c# dev kit | visual studio profiler | vs code profiler |
|---|---:|---:|---:|
| 2023 | 12.2 | 14.9 | 0 |
| 2024 | 18.1 | 13.5 | 0.2 |
| 2025 | 24.9 | 14.7 | 2.4 |
| 2026 | 48.8 | 15.0 | 6.5 |

C# Dev Kit の検索は 2023 年のリリース後に 4 倍になり、いまでは「visual studio profiler」の 3 倍です。「visual studio code」は「visual studio profiler」の人気の関連キーワードで、いまも上昇しています（+40%）。開発者は、いまコードを書いている場所で Visual Studio のプロファイラーを使いたいのです。

SharpLsp のプロファイラーは VS Code・Cursor・Windsurf・VSCodium で動きます。MIT ライセンスで、アカウントは不要です。エンジンは言語ではなく .NET ランタイムにアタッチするので、C# と F# を同じように扱えます。

## 6. コマンドラインツールが急増している

| 年 | dotnet-trace | dotnet-counters | dotnet-dump | dotnet-gcdump | perfview |
|---|---:|---:|---:|---:|---:|
| 2024 | 0.8 | 0 | 0.6 | 0 | 10.5 |
| 2025 | 4.8 | 3.6 | 2.3 | 0 | 33.9 |
| 2026 | 12.2 | 14.8 | 1.1 | 0 | 42.2 |

.NET の診断ツールは、2 年でほぼゼロから本格的な関心を集めるまでになりました。別の比較では、「dotnet monitor」が 2024 年の 2.5 から 2026 年の 34.4 に上がりました。測定した中で最大の .NET のパフォーマンス関連の検索語である BenchmarkDotNet は、2026 年に 23.0 から 47.1 へと倍増しました。

これらのツールは優れていて、SharpLsp のエンジンも `dotnet-trace` と同じ EventPipe チャネルを読みます。違いは答えがどこに現れるかです。`.nettrace` や `.gcdump` のファイルは PerfView、Visual Studio、speedscope で開く必要があり、そこで読むのはスタックであって、あなたのコードの行ではありません。SharpLsp は答えをエディターのその行に置きます。CPU セッションごとに speedscope JSON、`.cpuprofile`、フレームグラフの SVG も書き出すので、結果を共有したり保存したりできます。

## 人が検索するものと、SharpLsp が応える場所

| 検索するもの | SharpLsp の答え |
|---|---|
| high cpu usage | **Processes** のリアルタイムの CPU 列、そしてその行の **Profile CPU** |
| fix memory leak | **Track Memory**、順位付けされたリークの疑い、そして **Show Reference Graph** |
| .net memory profiler | メモリダッシュボード：ヒープのタイムライン、上位の割り当て箇所、リークの疑い |
| c# dispose, dependency injection | 何がまだオブジェクトを保持しているかを示す保持パス |
| flame graph | 結果パネルのズームできるフレームグラフと SVG の書き出し |
| visual studio profiler, in VS Code | 上記のすべてを、VS Code とそのフォークで、MIT ライセンスで |
| dotnet-trace, perfview | 同じランタイムのチャネルで、答えはあなたのコードの行に |

## 試してみる

SharpLsp は [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) から、または Cursor・Windsurf・VSCodium では [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) からインストールできます。SharpLsp ビューを開き、**Processes** でアプリを見つけてください。エンジンには .NET 8 以降のランタイムが必要です。[プロファイラーのドキュメント](/ja/docs/profiler/)にすべてのコマンドと設定があります。
