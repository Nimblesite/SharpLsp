---
layout: layouts/blog.njk
title: "Windows の .NET Framework を VS Code で：net48 を net10.0 と並べて実行・テスト、C# でも F# でも"
description: "Windows では、SharpLsp が .NET Framework 4.6.2〜4.8.1 のコードをデスクトップ CLR 上でビルド・実行・テストします。C# でも F# でも、VS Code・Cursor・Windsurf から、同じプロジェクトの最新 .NET ビルドと並べて。何ができて、何がまだできないのか、そしてなぜそれが重要なのか。"
lang: ja
date: 2026-10-14
author: SharpLsp チーム
image: /assets/images/blog/dotnet-framework-windows-vs-code.png
imageAlt: マルチターゲットプロジェクトの net48 ビルドがデスクトップ CLR で実行され、その横に net48 と net10.0 の結果を表示するテストエクスプローラーのツリー
tags:
  - posts
  - csharp
  - fsharp
  - testing
  - dotnet-lsp
category: engineering
excerpt: "毎日出荷される .NET の多くは、Windows 上の .NET Framework 4.8 です。SharpLsp はそれをすべての OS で編集でき、Windows では同じプロジェクトの net10.0 ビルドと並べて実行・テストもできます。"
---

カンファレンスで語られる .NET は `net10.0` です。でも、毎日出荷されている .NET の多くは `net48` です。業務アプリ、WCF サービス、経理チームが手放せない WinForms ツール、4.6.2 のままの大事なお客様を 1 社抱えたライブラリ。それらは Windows で動き、なくなることはなく、チームのエディターを自分たちで選べなかった理由であることもよくあります。

[0.23 以降](/ja/blog/dotnet-framework-multi-targeting-csharp-fsharp/)、SharpLsp はすべての OS で .NET Framework のコードを解析してきました。Windows では残りの仕事もこなします。**そのコードを本物のデスクトップ CLR でビルドし、実行し、テストする**のです。C# でも F# でも、いつものエディターから。

## なぜ重要なのか

- **.NET Framework はサポート終了ではありません。** .NET Framework 5 は出ませんが、4.8.1 は Windows の一部として出荷され、Windows とともにサービスされます。それを対象とするコードは、この先何年も保守されます。
- **移行は途中で起きます。** 大規模なコードベースを一度に移植する人はいません。プロジェクトは `net48;net8.0` をマルチターゲットし、1 つずつ移っていきます。そのため同じファイルが何か月も、多くの場合は何年も、両方のランタイム向けにコンパイルされます。片方しか扱えないエディターは、移行の半分しか扱えません。
- **古いコードほど、ツールの助けを必要とします。** 誰も書いた覚えのないコードをたどる、削除の前にすべての参照を探す、変更のたびにテストを実行する。15 年もののコードベースでは、それが毎日の仕事です。

多くのチームにとって、.NET Framework のプロジェクトは、全員が同じ IDE を使わなければならない最後の理由です。でも、そうである必要はありません。

## Windows でできること

| | SharpLsp がすること | 対象 |
| --- | --- | --- |
| **編集** | `#if NETFRAMEWORK` のコード内での補完、ナビゲーション、診断、リファクタリング。4.x の参照アセンブリに対して | すべての OS |
| **ビルド** | `dotnet build`。参照アセンブリは SDK が NuGet から取得し、インストールするターゲットパックはありません | すべての OS |
| **実行** | Ctrl+F5 で、マルチターゲットプロジェクトの `net48` ビルドをデスクトップ CLR で実行 | Windows |
| **テスト** | VSTest と MTP がすべてのフレームワークを検出・実行し、フレームワークごとに 1 つの結果を返します | Windows |
| **デバッグ** | 理由を示して拒否します。同じコードの .NET ビルドをデバッグしてください | — |

どれも `net462` から `net481` までが対象です。最新の Windows 10 と 11 に入っているインプレースの 4.8.x ランタイムが、そのすべてを実行します。

## 実行：デスクトップ CLR で Ctrl+F5

マルチターゲットプロジェクトで、ステータスバーから `net48` を選び、**Ctrl+F5** を押します。SharpLsp はタスク `Run <Project> (net48)` を開始します。

```text
dotnet run --project <proj> --framework net48
```

間にデバッグアダプターがないので、ビルドはコンパイル対象の CLR でそのまま起動します。プロジェクトのファイルから起動した場合、フレームワークはステータスバーのものになり、それ以外の場合はプロジェクトが最初に宣言しているものになります。どちらの場合も、出力チャネルに `Run: <Project> under net48` が記録されます。

## テスト：すべてのフレームワークを、1 つのツリーで

マルチターゲットのテストプロジェクトはテストエクスプローラーに 1 回だけ表示され、その行にフレームワークが並びます：`net48 · net10.0`。

- **各テストにタグが付きます。** そのテストを列挙するフレームワークごとに `tfm:net48`、`tfm:net10.0`。`#if NET48` の中にだけあるテストは、そこにだけ表示されます。
- **各結果は自分のフレームワークを知っています。** まとめた結果は最も悪いものになり、失敗には、失敗したフレームワークごとに `[net48]` で始まるメッセージが 1 つずつ付きます。「.NET Framework でだけ失敗する」が一目でわかります。
- **Run on `net48`** は独立した実行プロファイルです。ビルドしてから、そのフレームワークのアセンブリだけに対して `dotnet vstest` を実行します。`dotnet test --framework net48` は決して実行しません。ソリューション内で `net48` を対象としないすべてのプロジェクトが NETSDK1005 で失敗するからです。

## .NET Framework の MTP：.dll ではなく .exe

.NET 向けの Microsoft.Testing.Platform モジュールは、`dotnet exec` がホストする `.dll` です。.NET Framework では MSBuild が本物の `<Name>.exe` を生成し、`dotnet exec` はデスクトップ CLR をホストできないので、SharpLsp は `.exe` を直接起動します。C# の MSTest と F# の xUnit v3 で、それぞれ .NET と並べた `net48` でテストしています。

## F# も、同じ条件で

これは C# 専用ではありません。F# プロジェクトの `net48` のオプションは、MSBuild 自身のデザインタイムコンパイルから得られます：`--targetprofile:mscorlib`、4.8 の参照アセンブリ、そして `NETFRAMEWORK;NET48` の定義。F# のテストプロジェクトは VSTest でも MTP でも `net48` で実行でき、**Ctrl+F5** は F# のプログラムを C# のものとまったく同じようにデスクトップ CLR で実行します。

## まだできないこと：デスクトップ CLR のデバッグ

SharpLsp は、.NET 向けのオープンソースデバッガー netcoredbg を同梱しています。これは .NET Framework のデスクトップ CLR にはアタッチできず、来ることのないデバッガーを待つテストホストはハングするだけです。そこで SharpLsp は、そうならないようにしています。

- テストの **デバッグ** は、選択範囲の .NET フレームワークを実行します。.NET Framework だけの選択は、理由を示すメッセージとともにすぐに拒否されます。
- マルチターゲットのプログラムでの **F5** は、その .NET フレームワークをデバッグします。

移行の途中なら、たいていはこれで十分です。`net10.0` でデバッグし、`net48` で実行・テストします。

## Windows で作り、Windows でテストする

- **Windows 専用の CI。** 4 つの VS Code テストチャンクが Windows ランナーでのみ、本物の拡張機能を通して実行されます。.NET Framework プロジェクト上の言語サービス、テストエクスプローラー、そして固定コミットの 3 つの実リポジトリ（[GitReader](https://github.com/kekyo/GitReader)、[CsvHelper](https://github.com/JoshClose/CsvHelper)、[NLog](https://github.com/NLog/NLog)）です。
- Windows x64 と Arm64 向けの **ネイティブビルド**。サイドカーは名前付きパイプでホストと通信します。
- **細かいところまで。** 0.25 以降、`PATH` 上の `.cmd` や `.bat` のシムが、同梱のサイドカーの前に割り込むことはなくなりました（[#167](https://github.com/Nimblesite/SharpLsp/issues/167)）。Windows は移植先ではなく、テストするプラットフォームです。

## 試してみる

1. [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) または [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) から **SharpLsp 0.25** 以降をインストールします。VS Code、Cursor、Windsurf、VSCodium で使えます。
2. .NET Framework のバージョンと .NET のバージョンを対象とする SDK スタイルのプロジェクト（例：`net48;net10.0`）を含むソリューションを開きます。必要なのは .NET 10 SDK だけで、ターゲットパックも IDE のインストールも要りません。
3. ステータスバーで `net48` を選び、**Ctrl+F5** を押して、テストエクスプローラーを開きます。

スタック全体が MIT ライセンスです。アカウントも、シート数も、更新もありません。.NET Framework のプロジェクトがうまく動かなければ、[Issue を作成](https://github.com/Nimblesite/SharpLsp/issues)してください。実際の移行で使われている実際のプロジェクトファイルこそ、私たちが見たいものです。
