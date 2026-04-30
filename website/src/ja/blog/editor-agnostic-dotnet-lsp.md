---
layout: layouts/blog.njk
title: "なぜ .NET にエディター非依存の LSP が必要なのか"
description: "SharpLsp は、C# と F# のためのオープンソース .NET LSP を構築しています。VS Code、Zed、Neovim、Helix、Emacs、Rider など、あらゆるエディターで言語ツールが動作するようにするためです。"
lang: ja
date: 2026-04-28
author: SharpLsp チーム
image: /assets/images/blog/editor-agnostic-dotnet-lsp.png
imageAlt: 複数のエディターウィンドウが中央の言語サーバーコアに接続している図
tags:
  - posts
  - dotnet-lsp
  - language-server
category: architecture
excerpt: ".NET の言語サーバーは、ひとつのエディターに閉じ込められた機能ではなく、プラットフォーム機能であるべきです。そして現在、すべての選択肢に重大な条件が付いています。"
---

SharpLsp は C# と F# のためのオープンソース .NET 言語サーバーです。目的は VS Code 拡張機能をもうひとつ作ることではありません。目的は、[Language Server Protocol](https://microsoft.github.io/language-server-protocol/) を話すあらゆるエディターに対して .NET 開発体験を移植可能にすること、そしてどのプラットフォームでも最高のツールに本気で対抗できるものにすることです。

その目標は、これまで以上に重要です。なぜなら今、.NET 開発者が選べる選択肢にはどれも深刻な条件が付いているからです。

## Visual Studio は Windows 専用です。それで終わりです。

Visual Studio は C# ツールの金字塔です。Roslyn 統合、世界水準のプロファイラー、XAML デザイナー、Test Explorer、Edit and Continue。それは他のすべてが測られる基準です。そして Windows でしか動きません。

Microsoft は 2024 年 8 月に [Visual Studio for Mac を廃止](https://devblogs.microsoft.com/visualstudio/visual-studio-for-mac-retirement-announcement/) し、これを決定的にしました。Mac 開発者に推奨された道は、VS Code 用の C# Dev Kit を使うか、あるいは — ここが重要ですが — **仮想マシン内で完全な Windows 版 Visual Studio を実行する** ことでした。

> 「Mac 上の VM で Windows 版 Visual Studio IDE を実行する: この選択肢は、Xamarin、F#、リモート開発体験のようなレガシープロジェクトサポートを含め、最も広範な IDE のニーズをカバーします。」

もう一度読んでください。Mac 上の F# 開発者に対する Microsoft の公式推奨は、Windows VM を実行することです。これはクロスプラットフォームのストーリーではありません。Windows こそがプラットフォームであり、それ以外はすべて回避策である、と認める譲歩です。

## C# Dev Kit は代替にはなっていません

Microsoft が Visual Studio for Mac を廃止したとき、彼らは [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit) を代替として開発者に示しました。しかしコミュニティの評価は厳しいものでした。

C# Dev Kit は **[VS Marketplace で低いユーザー評価](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit)** を受けています — Microsoft 自身のファーストパーティ拡張機能でありながら、です。最近のレビューが状況を物語っています。

> "That just not works out of the box or after basic tinkering. Especially on macOS or Linux... Connection to LSP server just crashes and throws errors."
>
> （そのままでも、基本的な調整をしても動かない。特に macOS や Linux では…… LSP サーバーへの接続がクラッシュしてエラーを投げる。） — DKchshv, March 2026

> "It can't find installed .Net runtimes. Isn't this the very first thing it was supposed to do?"
>
> （インストール済みの .NET ランタイムを見つけられない。これは最初にできるはずのことではないのか？） — Emre Gönültaş, February 2026

> "Installing package 'Language server for Roslyn Copilot integration'. I did not ask for Copilot Integration. I do not want Copilot Integration. I was not asked if I wanted to opt-in. I am not presented with any option to disable it. Disgusting business practice."
>
> （「Language server for Roslyn Copilot integration」というパッケージをインストールしている。私は Copilot 統合を頼んでいない。Copilot 統合は望んでいない。オプトインしたいか確認されてもいない。無効化する選択肢も提示されない。ひどい商習慣だ。） — Matt Kaczmarek, April 2026

そしてライセンスの問題があります。C# Dev Kit は [エンタープライズチームには無料ではありません](https://marketplace.visualstudio.com/items/ms-dotnettools.csdevkit/license)。ユーザー数 250 名超、または年間売上 100 万ドル超のあらゆる組織は「Enterprise」に分類され、**有料の Visual Studio サブスクリプションなしには C# Dev Kit を使って商用アプリケーションを開発できません**。オープンソース開発者は無料で利用できます。商用チームはそうではありません。

信頼性とライセンスを越えて、機能差は現実です。C# Dev Kit には CPU プロファイラーがありません。メモリプロファイラーもありません。いかなるパフォーマンス分析ツールも存在しません。Visual Studio ではこれらは IDE のコア機能です。C# Dev Kit には単純に存在しないのです。

新しい LSP ベースの拡張機能のロードマップ発表が 2022 年に GitHub に出たとき、コミュニティは自分たちの感情を明確に示しました。[**1,035 件の thumbs-down リアクション**](https://github.com/dotnet/vscode-csharp/issues/5276) — Microsoft が新しいホストコンポーネントにクローズドソース部分を含めると明らかにした後の、リポジトリ史上最も否定的な受け止められ方です。怒りは理不尽ではありませんでした。オープンソースプロジェクトの OmniSharp の上にワークフローを築いてきた開発者たちは、後継には可視性のないプロプライエタリなコンポーネントが混ざると告げられたのです。

## Rider は良い — ただし別世界です

JetBrains Rider は本格的な IDE です。優れた F# サポート、クロスプラットフォーム、本物のプロファイラー、深い Roslyn 統合。IntelliJ 系の IDE に慣れていて、サブスクリプション料金を払う気があるなら、Rider は本物の選択肢です。

しかし Rider は VS Code とはまったく別の開発環境です。エディターを混在させるチーム — VS Code を使う人、Neovim を使う人、Zed を使う人がいるチーム — は Rider ベースのワークフローを共有できません。Rider の .NET インテリジェンスは Rider の中で生きています。他のエディターが利用できる標準 LSP サーバーとして公開されてはいません。Rider を離れれば、そのツールも完全に置いていくことになります。

## F# は二級市民として扱われています

F# は業務アプリケーションのための世界水準の言語です。強い型付け、代数的データ型、コンピュテーション式、そして本番に届く前に膨大な種類のバグを捕まえるコンパイラー。金融システム、データパイプライン、ドメイン重視のアプリケーションを構築する企業には、F# を選ぶ十分な理由があります。

しかしツールサポートは別の物語を語ります。

Visual Studio の F# サポートは C# に何年も遅れています。Rider はそれより良いです。VS Code の Ionide は実際の制約の中で重要な仕事をしているコミュニティ管理の拡張機能です。しかし Microsoft からも、それ以外からも、F# ツールをすべてのエディターで C# と同等の地位に置くストーリーはありません。F# は常に後付けで、ボルトオンで、C# のロードマップが埋まると延期される機能です。

Microsoft 自身の廃止発表もこれを率直に認めていました。Visual Studio for Mac で失われるものを列挙したとき、F# は Windows VM を実行する理由として明示的に挙げられたのです。

## プラットフォームの問題

これらすべてが合わさると、断片化した .NET 開発者体験になります。

- **Windows**: Visual Studio を使う。最高水準のツールだが、プラットフォームに縛られる。
- **macOS / Linux で VS Code**: C# Dev Kit を使い、信頼性の問題を受け入れ、ライセンス制約を受け入れ、プロファイラーがないことを受け入れ、F# が二次的であることを受け入れる。
- **macOS / Linux で完全なツールが欲しい場合**: Rider を使い、サブスクリプション費用と、囲い込まれたエコシステムであることを受け入れる。
- **Neovim、Helix、Zed、Emacs**: 公式サーバーが対象としていないため、コミュニティが OmniSharp や clangd 風のセットアップから何とか組み合わせたものを受け入れる。

全体像を提供する単一のオープンソース、クロスプラットフォーム、エディター非依存の .NET 言語サーバーは存在しません。

## SharpLsp が構築しているもの

SharpLsp はインストール済みの `sharplsp` バイナリ 1 つを中心に構築されています。エディタークライアントはそれを `PATH` から見つけ、標準入力／標準出力で起動します。同じサーバーが C#、F#、ソリューション検出、セマンティックリクエスト、診断、SharpLsp 独自リクエストを処理します。

アーキテクチャは意図的に分割されています。

- **Rust ホスト** が LSP 接続、仮想ファイルシステム、リクエストルーティング、tree-sitter による構文処理、サイドカーのライフサイクルを所有します。
- **C# サイドカー** がセマンティックな C# 機能のために [Roslyn](https://github.com/dotnet/roslyn) をホストします。
- **F# サイドカー** がセマンティックな F# 機能のために [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) をホストします。
- **F# は後付けではありません。** 可能な箇所では F# 機能を C# 機能より先に構築し、F# は初日から第一級のターゲットです。

これが、VS Code 拡張機能がソリューションエクスプローラーとプロファイラービューを提供できる一方で、同じ `sharplsp` が標準の LSP 機能のみをサポートするエディターにもサービスを提供できる理由です。

アルファ版はまず VS Code パスを堅牢にすることに集中しています。それが正しい検証の場だからです。長期的なターゲットは、オープンソースの .NET ツールスタックをひとつ、サーバーをひとつ、すべてのエディターに、プロファイラー付きで届けることです。

## 実際にはどう見えるのか

エディター非依存の .NET LSP とは、次のようなものです。

- **C# と F# の言語インテリジェンス** が同じインストール済みサーバーから提供され、macOS、Linux、Windows のいずれでも、VM を必要とせずに動作する
- **席単位のライセンスがない。** オープンソース。Enterprise の例外条件もない。
- **動作するプロファイラー** — Visual Studio の中にも、Rider のサブスクリプションの裏側にも閉じ込められていない
- **一貫した診断とナビゲーションのセマンティクス** が、VS Code、Zed、Neovim、Helix のどれでも得られる
- **F# が本来の言語として扱われる** — C# が「完成」するまで延期される対象ではない

.NET エコシステムは、Windows、評価の低いファーストパーティ拡張機能、あるいは単一の商用 IDE ベンダーの人質にされるには、優れすぎています。

## 基準は単純です

SharpLsp は、実際の .NET 作業をより良くするかどうかで判断されるべきです。ソリューションを開く、コードをナビゲートする、エラーを修正する、パッケージを管理する、実行中のプロセスをプロファイルする、デバッグする — プロプライエタリなツールチェーンや Windows VM に強制されることなく。

エディターは好みであるべきです。言語ツールはインフラであるべきです。
