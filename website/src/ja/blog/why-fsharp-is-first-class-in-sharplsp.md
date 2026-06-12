---
layout: layouts/blog.njk
title: "なぜ SharpLsp で F# が一等市民なのか"
description: "SharpLsp は、F# のコミュニティ、コンパイラー、ツールスタック、本番利用の実績が、初日から F# のために設計されたツールに値するため、F# を一等の .NET 言語として扱います。"
lang: ja
date: 2026-04-26
author: SharpLsp チーム
image: /assets/images/blog/why-fsharp-is-first-class-in-sharplsp.png
imageAlt: 回路基板上の関数型プログラミングパイプラインとコンパイラーサービスモジュール
tags:
  - posts
  - fsharp
  - dotnet-lsp
  - language-server
category: fsharp
excerpt: "F# は C# のサイドクエストではありません。この言語、コミュニティ、本番利用の実績には、最初から F# のセマンティクスを中心に構築されたエディターツールが必要です。"
---

SharpLsp は C# と F# のための .NET 言語サーバーです。この表現は意図的なものです。F# は将来の互換性メモでも、後から統合する予定のものでも、C# の横に置かれたチェックボックスでもありません。

F# は一等に扱われるべきです。真剣なコミュニティに支えられた、真剣な本番用言語だからです。Microsoft は F# を ["succinct, robust and performant code"](https://learn.microsoft.com/en-us/dotnet/fsharp/what-is-fsharp) のための言語と説明しています。公式の .NET 言語戦略は、F# 開発者が ["simply love working in it"](https://devblogs.microsoft.com/dotnet/the-net-language-strategy/) と述べ、F# を ["best-tooled functional language on the market"](https://devblogs.microsoft.com/dotnet/the-net-language-strategy/) にするという意欲を示しています。

それは正しい意欲です。しかし現在のエディター体験には、まだギャップがあります。

同じ言語戦略は、F# ツールが C# や Visual Basic のより豊かな体験には ["doesn't quite measure up"](https://devblogs.microsoft.com/dotnet/the-net-language-strategy/) とも述べていました。これは 2017 年に書かれたものですが、それ以降の公開コミュニティスレッドにも馴染みのあるパターンが見えます。言語は素晴らしい。コミュニティも素晴らしい。しかし日々のツール体験には、まだ投資が必要です。

SharpLsp は、その投資をアーキテクチャとして行うために存在します。

## コミュニティはすでに並外れた仕事をしている

F# ツールについて誠実に書くなら、まず既存エコシステムを作ってきた人々への敬意から始める必要があります。F# コミュニティは、完璧なベンダーサポートを待っていませんでした。ツールを作りました。

[Ionide](https://ionide.io/index.html) は自らを明確にこう説明しています。

> "We build cross platform, F# developer tooling" - [Ionide](https://ionide.io/index.html)
>
> 私たちはクロスプラットフォームな F# 開発者ツールを作っています。

Ionide の主力 VS Code 拡張機能は [100 万回以上ダウンロード](https://ionide.io/index.html)されており、プロジェクトは実際のツールチェーンを文書化しています。[FSAutoComplete](https://ionide.io/Tools/fsac.html)、[FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/fcs/)、Fantomas、FSharpLint、アナライザー、プロジェクト情報、LSP 通信です。[Ionide の VS Code 概要](https://ionide.io/Editors/Code/overview.html)には、F# 開発者が生産的なエディターに期待する機能が並んでいます。オートコンプリート、定義ジャンプ、ツールチップ、リネーム、リファクタリング、クイックフィックス、F# Interactive、ワークスペースエラー、プロジェクトエクスプローラー、デバッガー統合などです。

その仕事は脚注ではありません。クロスプラットフォーム F# 開発が長年にわたり成立してきた理由です。

コミュニティもそれを理解しています。

> Ionide is an absolute treasure.Pioneered so many tooling features that VS and Rider now have too.
>
> - [r/fsharp, "F# Weekly #47, 5 years of Ionide"](https://www.reddit.com/r/fsharp/comments/jy9dgq)
>
> Ionide は本当に宝物です。VS や Rider が今持っている多くのツール機能を先駆けました。

この引用が重要なのは、正しい姿勢を表しているからです。まず感謝です。Ionide と FSAutoComplete は巨大な負荷を背負ってきました。SharpLsp はその仕事への批判ではありません。次の層のオープンな .NET ツールはそこから学び、正しいコンパイラープリミティブを再利用し、F# にアーキテクチャ上のより大きな席を与えるべきだという賭けです。

## 痛みもまた本物である

敬意は否認を必要としません。F# 開発者は、体験がどこで壊れるのかを率直に語ってきました。

ある r/fsharp ユーザーは、VS Code 体験をこう表現しました。

> this does feel very shaky compared to every other language I've worked with.
>
> - [r/fsharp, "Ionide in VS Code (and tooling in general) is pushing me away from F#"](https://www.reddit.com/r/fsharp/comments/t6uyrh)
>
> これは、私が使ってきた他のどの言語と比べてもかなり不安定に感じます。

同じ議論では、具体的な失敗モードも抽象的ではありませんでした。

> Ionide wouldn't stop flagging this code as erroneous until I restarted VSCode altogether.
>
> - [r/fsharp, same thread](https://www.reddit.com/r/fsharp/comments/t6uyrh)
>
> VSCode を完全に再起動するまで、Ionide はこのコードをエラーとしてマークし続けました。

別のユーザーは、より好意的ながらも条件付きの評価を述べています。

> ionide f# isnt that bad by comparison if you keep project scaffolding "vanilla".
>
> - [r/fsharp, same thread](https://www.reddit.com/r/fsharp/comments/t6uyrh)
>
> プロジェクトの足場を「普通」のままにしておけば、比較すると ionide f# はそれほど悪くありません。

その「もし」が問題です。真剣な F# ユーザーは、混合プロジェクト、生成アセット、パッケージ restore、アナライザー、スクリプト、複数ターゲットフレームワーク、ビルドロジックを含む実際のソリューションで作業します。プロジェクト形状が単純なときだけ機能するツールは、一等言語の基準を満たしません。

同じテーマは繰り返し現れます。

> I love the language and all the rest of the tooling is fantastic at this point, but every time ionide fails to load...
>
> - [r/fsharp, "Ionide doesn't load projects"](https://www.reddit.com/r/fsharp/comments/13wm3gm)
>
> 私はこの言語が好きで、他のツールは現時点で素晴らしいのですが、ionide がロードに失敗するたびに...

> Yeah the tooling in general feels slower, less reliable than that of more mainstream langs - likely cause less devs, cos, and funding supporting it.
>
> - [r/fsharp, "Why is F# not loved as much as comparable FP-hybrids?"](https://www.reddit.com/r/fsharp/comments/16u52m4)
>
> 全体的にツールは、より主流の言語より遅く、信頼性も低く感じます。支える開発者、企業、資金が少ないからでしょう。

> The tooling for F# pales in comparison with the tooling for C# though.
>
> - [r/fsharp, "FSharp in VS Code"](https://www.reddit.com/r/fsharp/comments/1bvsyyu)
>
> ただ、F# のツールは C# のツールと比べると見劣りします。

> TBH I'm finding Visual Studio 2019 a more reliable environment for F# coding, I would prefer to use VS Code...
>
> - [r/fsharp, "No red squiggly lines in VS Code / Ionide"](https://www.reddit.com/r/fsharp/comments/p0bh3z)
>
> 正直なところ、F# コーディングでは Visual Studio 2019 の方が信頼できる環境だと感じています。本当は VS Code を使いたいのですが...

これらは逸話であり、ベンチマークデータではありません。それでも公開された逸話は重要です。SharpLsp が改善しなければならないユーザー体験を正確に示しているからです。プロジェクトロード、古い診断、セマンティックレイテンシ、メモリ圧迫、エディター再起動、波線がコンパイラーの同意を意味しているという確信です。

## 数字が示すのはニッチであって弱さではない

Stack Overflow の 2025 Developer Survey は、F# の利用率を[全回答者で 1.3%、プロフェッショナル開発者で 1.2%](https://survey.stackoverflow.co/2025/technology)と報告しています。これはニッチです。失敗ではありません。

同じ 2025 年調査は、プログラミング言語の「Admired and Desired」セクションで、F# を[希望 2.9%、称賛 49.1%](https://survey.stackoverflow.co/2025/technology)と報告しています。調査データには限界があり、Stack Overflow の回答者集団は国勢調査ではありません。それでも信号は、F# ユーザーが公開の場で語っていることと一貫しています。F# は熱心なユーザーベースを持つ小さな言語であり、行き止まりではありません。

2023 年の分析 ["The State of F#"](https://hamy.xyz/labs/2023-06-state-of-fsharp) も、その年の調査データから同じ基本的な点を示しました。低い利用率、高い愛着、回答者の中で高い給与ランキングです。その結論は、F# が主流だというものではありませんでした。F# は既知のニッチ言語であり、ユーザーはしばしば使い続けたいと思っている、というものでした。

まさにそういう言語でこそ、ツールが最も重要です。大きな言語は、エコシステムの重力だけで平凡なエディターサポートを生き延びられます。小さな言語はそうはいきません。F# にとって優れたツールは仕上げではありません。採用のための基盤です。

## F# はセマンティックに異なる

F# は句読点が違う C# ではありません。この言語には異なる編集要件があり、その要件は実際のセマンティクスから来ています。

Visual Studio 16.9 向けの Microsoft の F# ツール更新は、F# でセマンティックなエディター機能がなぜ難しいかを説明しています。F# は型推論を使うため、1 つのソースファイルの変更がプロジェクトやソリューションの後続位置の型に影響するからです。その投稿は、型チェック済みデータに依存する機能がコンパイラーの型チェック作業の影響を受けることを明示し、大規模コードベースで union case や広く使われる関数の戻り値型を変えることによる下流影響を挙げています。また、シグネチャファイルが下流の型チェック作業を制限することで IDE パフォーマンスを改善できる理由も説明しています。出典: [F# and F# tools update for Visual Studio 16.9](https://devblogs.microsoft.com/dotnet/f-and-f-tools-update-for-visual-studio-16-9/)。

この 1 つの事実だけでも、LSP には大きな影響があります。

- プロジェクトファイルの順序は見た目の問題ではありません。F# のコンパイル順序は意味を変えます。
- 推論された型はソースに書かれていないことが多いため、ホバーが中心的な機能になります。
- 補完は構文だけでなく、型チェッカーの状態を理解する必要があります。
- `.fs`、`.fsi`、`.fsx` ファイルには異なるワークフローがあります。
- F# Interactive は開発ループの一部です。
- シグネチャファイルは API 設計ツールであり、パフォーマンスツールでもあります。
- Type provider とアナライザーは、一般的な C# 前提ではカバーできない言語サービス圧力を生みます。

公式の [FSharp.Compiler.Service ドキュメント](https://fsharp.github.io/fsharp-compiler-docs/fcs/)も、このアーキテクチャ上の点を裏付けています。FCS は ["auto-completion, tool-tips, parameter information"](https://fsharp.github.io/fsharp-compiler-docs/fcs/) のためのエディターサービス、プロジェクト全体解析、F# Interactive のホスティング、コンパイラーの組み込みを提供します。また、Visual Studio の F#、FsAutoComplete、Rider の F# サポート、.NET Interactive、Fantomas、FSharpLint、Fable、WebSharper などのプロジェクトで使われている、コンパイラーベースの基盤でもあります。

言い換えると、本物の F# ツールは FCS から始まります。F# を C# のセマンティックモデルに流し込めるふりをするところからは始まりません。

## よい動きも起きている

F# ツールは止まっていません。2025 年 11 月に .NET 10 とともに公開された F# 10 には、明示的なパフォーマンスとツールの作業が含まれています。

[Introducing F# 10](https://devblogs.microsoft.com/dotnet/introducing-fsharp-10/) は、このリリースに type subsumption cache が含まれ、型チェックを高速化し、特に複雑な型階層を持つプロジェクトで IDE の応答性を改善すると説明しています。また、`ParallelCompilation` プロジェクトプロパティの下にまとめられた並列コンパイル作業、スクリプト向け `--typecheck-only` サポート、パフォーマンス改善とツールアップグレードに関する進行中の F# 11 作業にも触れています。

F# 10 の投稿が重要なのは、作業をしている人々にも光を当てているからです。F# は .NET Foundation、F# Software Foundation、メンバー、コントリビューター、Microsoft の協力で開発されていると述べ、ツール、診断、パーサー回復、テスト基盤、パフォーマンス改善に関するコミュニティコントリビューターを挙げています。また、コントリビューターを支援する [Amplifying F#](https://amplifyingfsharp.io/) も認識しています。

それが F# の物語です。真剣なコンパイラー、真剣なオープンプロセス、そして継続して現れるコミュニティです。

## 本番の F# は仮説ではない

F# の価値は好みだけの問題ではありません。実際の本番事例があります。

公式の [F# testimonials](https://fsharp.org/testimonials/) ページには、メッセージング基盤、公的記録解析、Microsoft Bing Ads のランキング割り当てと価格設定、Microsoft Research の生物計算、保険計算、マネーロンダリング対策、銀行、健康診断、税務ソフトウェア、ルールエンジン、ゲノミクス、衛星システムなどで F# を使う企業やチームが掲載されています。

いくつかの例を挙げます。

- [Microsoft Bing Ads Ranking Allocation and Pricing](https://fsharp.org/testimonials/) は、関連プロジェクトコードのおよそ 95% が F# で開発されたと報告しました。
- [Microsoft Research's Biological Computation group](https://fsharp.org/testimonials/) は、F# を「科学計算のための選択言語」と表現しました。
- [ClearTax](https://fsharp.org/testimonials/) は「製品全体を F# でゼロから構築した」と述べました。
- [Compositional IT](https://fsharp.org/testimonials/) は、90 以上の市場にまたがる複雑なルールとデータ変換のリリースについて、「F# just works」と報告しました。
- [CODE Magazine の Jet.com ケーススタディ](https://www.codemag.com/Article/1611071/F-Microservices-A-Case-Study) は、F# マイクロサービスを本番における関数型プログラミングの「successful, real-world case」として紹介しました。
- Microsoft 自身の ["Why you should use F#"](https://devblogs.microsoft.com/dotnet/why-you-should-use-f/) 投稿は、Jet.com を含む「big things」に F# が使われていると述べました。
- [G-Research](https://www.gresearch.com/news/going-15-percent-faster-with-graph-based-type-checking-part-two/) は、大規模ソリューション内のすべての F# プロジェクトに対してグラフベースの型チェック作業を検証し、機能フラグの有無で同じバイナリ出力になることを証明した話を公開しています。

より広いコミュニティにも、同じ実感があります。

> I have a job writing F# (had no knowledge before I got it) in the UK.
>
> - [r/fsharp, "FP languages amongst the highest paying ones according to the StackOverflow Survey 2024"](https://www.reddit.com/r/fsharp/comments/1ec75rn)
>
> 英国で F# を書く仕事をしています（就職前は何も知りませんでした）。

> F# has been our primary language for around 6 years now, at least for anything new.
>
> - [r/fsharp, "Who's using F#? What are you using it for?"](https://www.reddit.com/r/fsharp/comments/13m4n7f)
>
> F# はおよそ 6 年間、少なくとも新しいものについては私たちの主要言語です。

> Me, we, our company, in production.
>
> - [r/dotnet, "Who's using F#? What are you using it for?"](https://www.reddit.com/r/dotnet/comments/13l6coy/question_whos_using_f_what_are_you_using_it_for/)
>
> 私、私たち、私たちの会社が、本番で使っています。

これらの話はマーケティング演出ではありません。F# がすでに重要な仕事を担っている証拠です。ツールは、その言語が実際に使われている場所に合わせるべきです。

## SharpLsp における一等とは何か

SharpLsp は共有 LSP 動作のために Rust ホストプロセスを使い、セマンティック言語作業をコンパイラーベースのサイドカーに委譲します。

- C# のセマンティックリクエストは Roslyn サイドカーに向かいます。
- F# のセマンティックリクエストは [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/fcs/) サイドカーに向かいます。
- ホストはルーティング、キャンセル、ワークスペース通知、サイドカーのライフサイクル、エディタープロトコル動作を担当します。

この構造こそが重要です。F# は F# に必要なコンパイラーサービスを得ます。C# は Roslyn を得ます。共有ホストは、重複すべきではないプロトコル、ファイルシステム、エディター、キャッシュ、キャンセル、ライフサイクルの仕組みを扱います。

SharpLsp において、一等の F# は具体的な製品要件を意味します。

- F# プロジェクトは F# を理解するプロジェクト評価でロードされます。
- F# 診断は FSharp.Compiler.Service と F# アナライザーから来ます。
- F# のホバー、補完、定義、参照、リネーム、コードアクションは実際の言語機能として追跡されます。
- F# Interactive ワークフローは意図的に公開され、任意の追加機能扱いされません。
- `.fs`、`.fsi`、`.fsx` の動作は別々にテストされます。
- F# フォーマッター統合は C# のフォーマット前提をコピーするのではなく、Fantomas を尊重します。
- F# lint とアナライザー作業には、サーバーを通る一等の経路があります。
- C# と F# が混在するソリューションは、F# を C# プロジェクトモデルに押し込まずに動作します。

その一部は完了しています。一部は進行中です。重要なアーキテクチャ上の選択はすでに行われています。F# はサイドクエストではありません。

## 共有 .NET ツールも重要である

一等であることは孤立を意味しません。C# と F# プロジェクトは同じソリューションに共存することがよくあります。開発者は依然として、1 つのソリューションビュー、1 つのビルドストーリー、1 つのデバッガーパス、1 つのプロファイラー、1 つのパッケージ管理サーフェスを必要とします。

正しいモデルは、エコシステムが共有されているところでは共有インフラを使い、正確性が要求するところでは専用言語サービスを使うことです。

だから SharpLsp は、1 つのインストール済みサーバーと専用サイドカーを持ちます。エディターが開発者に C# と F# の品質のどちらかを選ばせるべきではありません。.NET ソリューションは 1 つのソリューションのように感じられるべきであり、それぞれの言語はふさわしいコンパイラーインテリジェンスを得るべきです。

## 基準

F# 開発者が C# 製品のゲストだと感じずに SharpLsp を日常のツールとして使えるようになるまで、F# サポートは完了ではありません。

F# コミュニティはすでに自分たちの役割を果たしてきました。Ionide、FsAutoComplete、Fantomas、FSharpLint、Fable、FAKE、Paket、アナライザー、ドキュメント、講演、チュートリアル、本番システムを作りました。オープンな設計、オープンな実装、オープンなコミュニティ支援を通じて、この言語を前に進めてきました。

SharpLsp の仕事は、その仕事にスローガンではなくアーキテクチャで応えることです。

F# は一等の .NET 言語です。SharpLsp はそれに合わせて構築しています。
