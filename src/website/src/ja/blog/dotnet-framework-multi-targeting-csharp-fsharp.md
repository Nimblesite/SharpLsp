---
layout: layouts/blog.njk
title: "VS Code で .NET Framework とマルチターゲット：すべてのフレームワークを、C# でも F# でも"
description: "SharpLsp 0.23 は、プロジェクトが対象とするすべてのフレームワーク（.NET Framework、.NET Standard、最新の .NET）に C# と F# の完全な言語サポートを提供します。ステータスバーからのフレームワーク切り替え、フレームワークごとに実行できるテストエクスプローラーも。Windows・macOS・Linux で。"
lang: ja
date: 2026-10-13
author: SharpLsp チーム
image: /assets/images/blog/dotnet-framework-multi-targeting-csharp-fsharp.png
imageAlt: 1本のエメラルド色の道が分岐して3つの彫刻的な門を通り、1つのプロジェクトで複数の .NET フレームワークを対象とする様子を表現
tags:
  - posts
  - csharp
  - fsharp
  - testing
  - dotnet-lsp
category: engineering
excerpt: "実際のライブラリは、1 つのプロジェクトファイルで net462 と net10.0 を同時に対象にしています。SharpLsp 0.23 は、そのすべてのフレームワークに C# でも F# でも完全な体験を提供し、テストエクスプローラーでそれぞれを実行できます。"
---

本格的な .NET ライブラリを開くと、ほぼ必ずこんな行があります。

```xml
<TargetFrameworks>net462;net48;netstandard2.0;net8.0;net10.0</TargetFrameworks>
```

プロジェクトファイルは 1 つ、フレームワークは 5 つ。そして、そのうち 1 つでしかコンパイルされない `#if NETFRAMEWORK` のコードの島。多くのエディターは黙って 1 つのフレームワークだけを選び、残りは存在しないものとして扱います。その結果、.NET Framework のお客様のためにまさにデバッグしているコードが、灰色で、解析されず、幻のエラーだらけになります。

**SharpLsp 0.23 は、プロジェクトが宣言するすべてのフレームワークに完全な体験を提供します。F# でも C# とまったく同じように。** 実際に何ができるのかを見ていきましょう。

## フレームワークを切り替えると、コードが変わる

フォーカスしているファイルがマルチターゲットのプロジェクトに属していると、ステータスバーにそのアクティブなフレームワーク（たとえば `net48`）が表示されます。クリックするか **SharpLsp: Select Target Framework** を実行して、別のフレームワークを選びます。

切り替えは **プロジェクト全体に、両方の言語で** 適用されます。

- `#if NET48` の領域が有効になり、`#else` 側が灰色になります。
- フレームワーク固有の API が解決されます。あるいは、本来のエラーとして表示されます。
- 開いているすべてのドキュメントの診断が再発行されます。
- セマンティックハイライト、インレイヒント、CodeLens がすぐに更新されます。

既定値は Visual Studio と同じく `<TargetFrameworks>` の最初のエントリです。

## C#：フレームワークごとに 1 つの Roslyn コンテキスト

`MSBuildWorkspace` はフレームワークごとに 1 つの Roslyn プロジェクト（`Csv(net48)`、`Csv(net8.0)`）を作るので、各ドキュメントはフレームワークごとにコンテキストを持ち、すべてのリクエストは **アクティブな** コンテキストから応答します。

マルチターゲットでよく問題になるのは、プロジェクト全体にわたるクエリです。参照の検索、CodeLens の件数、実装、呼び出し階層と型階層、デッドコード解析は、各プロジェクトのアクティブなフレームワークを検索し、**それぞれの場所を 1 回だけ** 報告します。フレームワークごとに、あるいはプロパティのアクセサー経由で、同じ使用箇所が重複してカウントされることはありません。

## F#：フレームワークごとに MSBuild のオプション

F# も同じ扱いで、コンパイラオプションは推測ではありません。SharpLsp はフレームワークごとに、MSBuild にプロジェクトの実際のデザイン時コンパイルを問い合わせます。

```text
dotnet msbuild <fsproj> -p:TargetFramework=net48 -p:DesignTimeBuild=true
  -p:SkipCompilerExecution=true -p:ProvideCommandLineArgs=true ...
  -getItem:FscCommandLineArgs -getItem:ReferencePathWithRefAssemblies
```

そのため `net48` は `--targetprofile:mscorlib`、4.8 の参照アセンブリ、`NETFRAMEWORK;NET48;…_OR_GREATER` でコンパイルされ、ソースの順序、glob、条件、`Directory.Build.*` は SharpLsp ではなく MSBuild のものです。所要時間はフレームワークあたり約 1 秒。最初のフレームワークは読み込み時に、ほかは最初の切り替え時に構築され、その後は保持されます。

見た目以上に重要な点が 2 つあります。

- **コンソール専用のフラグは外します。** MSBuild は自身のログのために `--flaterrors` を渡し、すべてのコンパイラメッセージを 1 行にまとめます。これを残したエディターでは、すべての診断と、それを読むすべてのクイックフィックスから改行が失われます。
- **失敗したら、はっきりと縮退します。** デザイン時コンパイルが失敗すると、プロジェクトは `<Compile>` 項目にフォールバックし、ログにその理由が正確に記録されます。黙って中途半端に読み込まれたプロジェクトではなく、動くエディターと説明が手に入ります。

ほかの F# プロジェクトを参照する F# プロジェクトは、MSBuild がその参照のために実際に選んだフレームワークから、メモリ上で読み込みます。

## どの OS でも解析できる

SDK は `Microsoft.NETFramework.ReferenceAssemblies` を自動的に参照するので、**.NET Framework のコードは macOS と Linux でも解析されます。** `net48` の補完、ナビゲーション、診断は MacBook でも動きます。ただし実行は別の話です。

| ターゲット | 解析 | ビルド | 実行／テスト | デバッグ |
| --- | --- | --- | --- | --- |
| `net462`–`net481` | すべての OS | すべての OS | Windows のみ | 理由を示して拒否 |
| `netstandard2.0`/`2.1` | すべての OS | すべての OS | なし（ライブラリ） | — |
| `net8.0` 以降 | すべての OS | すべての OS | そのランタイムが必要 | netcoredbg |

ランタイムがないフレームワーク（たとえば 8 と 10 しかないマシンでの `net9.0`）は、失敗したテストや欠けたテストとしてではなく、**名前を挙げて** 実行不可と報告されます。

## フレームワークを理解するテストエクスプローラー

[テストエクスプローラー](/ja/blog/microsoft-testing-platform-mtp-dotnet-test-csharp-fsharp/)は、VSTest と MTP の両方で、C# と F# のマルチターゲットのテストプロジェクトを理解するようになりました。

- **検出** — マルチターゲットのプロジェクトの行にはそのフレームワーク（`net48 · net8.0`）が並び、各テストには、それを列挙したフレームワークごとに `tfm:<tfm>` タグが付きます。`#if NET48` の中にだけあるテストは、そこにだけ表示されます。
- **結果** — 各結果はそのフレームワークに結び付けられます。まとめた結果は最も悪いものになり、失敗には失敗したフレームワークごとに `[net48]` で始まるメッセージが付きます。
- **フレームワークを指定して実行** — 検出したフレームワークごとに **Run on `<tfm>`** プロファイルがあります。ビルドしてから、そのフレームワークのアセンブリに対して `dotnet vstest` を実行します。`dotnet test --framework` は使いません。そのフレームワークを対象にしていないすべてのプロジェクトで NETSDK1005 になって失敗するからです。
- **.NET Framework での MTP** — .NET Framework の MTP モジュールは `.exe` として直接実行されます。`dotnet exec` はデスクトップ CLR をホストできないためです。Windows 以外では起動せず、その理由を明示します。

## デバッグ：デスクトップ CLR について正直に

netcoredbg は .NET をデバッグでき、.NET Framework のデスクトップ CLR はデバッグできません。決してアタッチされないデバッガーを待つテストホストはただハングするだけなので、SharpLsp はそうさせません。

- テストの **デバッグ** は、選択範囲の .NET フレームワークで実行します。.NET Framework だけの選択はすぐに拒否され、「実行」を使うか、プロジェクトの .NET フレームワークのいずれかでデバッグするよう案内するメッセージが表示されます。
- マルチターゲットのプログラムで **F5** を押すと、アクティブなフレームワークが .NET ならそれを、そうでなければ宣言されている最初の .NET フレームワークをデバッグします。
- **Ctrl+F5** はデバッガーなしで `dotnet run --framework <active>` を実行します。.NET Framework のビルドも、デスクトップ CLR 上で実行できます。

## 実際のリポジトリで実証

このような機能には合成フィクスチャだけでは足りません。そこで Windows の CI チャンクが、マルチターゲットの実在のリポジトリ 3 つを固定コミットでクローンし、実際の拡張機能を通して動かします。

| リポジトリ | 言語 | ターゲット |
| --- | --- | --- |
| [kekyo/GitReader](https://github.com/kekyo/GitReader) | F# と C# | `net35`…`net481`、`netstandard1.6`–`2.1`、最新の .NET |
| [JoshClose/CsvHelper](https://github.com/JoshClose/CsvHelper) | C# | `net462;net47;net48;netstandard2.0;2.1;net8.0;net9.0` |
| [NLog/NLog](https://github.com/NLog/NLog) | C# | `net35;net46;netstandard2.0;netstandard2.1` |

どれも読み込みに成功し、`#if NETFRAMEWORK` のコード内で言語リクエストに応答し、.NET Framework のテストアセンブリを検出して、フレームワークごとの結果を報告します。

## 試してみる

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) または [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) から **SharpLsp 0.23** 以降に更新し、マルチターゲットのソリューションを開いて、ステータスバーのフレームワークをクリックしてください。

うまく動かないプロジェクトを見つけたら、[Issue を作成](https://github.com/Nimblesite/SharpLsp/issues)してください。SharpLsp を壊す実在の `<TargetFrameworks>` 行こそ、私たちが見たいものです。
