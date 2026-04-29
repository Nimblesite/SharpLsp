---
layout: layouts/blog.njk
title: "なぜ .NET にはエディター非依存の LSP が必要なのか"
description: "SharpLsp は、C# と F# 向けのオープンソース .NET LSP を構築しています。VS Code、Zed、Neovim、Helix、Emacs、Rider など、あらゆるエディターで言語ツールを使えるようにするためです。"
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
excerpt: ".NET の言語サーバーは、1 つのエディターに閉じ込められた機能ではなく、プラットフォーム機能であるべきです。現状の選択肢には、どれも重大な条件が付いています。"
---

SharpLsp は C# と F# のためのオープンソース .NET 言語サーバーです。目的は、VS Code 拡張をもう 1 つ作ることではありません。目的は、[Language Server Protocol](https://microsoft.github.io/language-server-protocol/) を話せるあらゆるエディターへ .NET 開発体験を持ち運べるようにし、どのプラットフォームの優れたツールにも本気で対抗できるものにすることです。

この目標は、これまで以上に重要です。なぜなら今、.NET 開発者が選べる選択肢には、どれも深刻な条件が付いているからです。

## Visual Studio は Windows 専用。それで終わりです。

Visual Studio は C# ツールの金字塔です。Roslyn 統合、世界水準のプロファイラー、XAML デザイナー、Test Explorer、Edit and Continue。ほかのすべての選択肢は、これを基準に測られます。そして Visual Studio は Windows でしか動きません。

Microsoft は 2024 年 8 月に [Visual Studio for Mac を廃止](https://devblogs.microsoft.com/visualstudio/visual-studio-for-mac-retirement-announcement/)し、この事実を決定的なものにしました。Mac 開発者に推奨された道は、VS Code の C# Dev Kit を使うか、あるいは、ここが重要ですが、**仮想マシン内で完全な Windows 版 Visual Studio を動かす**ことでした。

> 「Mac 上の VM で Windows 版 Visual Studio IDE を実行する: この選択肢は、Xamarin、F#、リモート開発体験のレガシープロジェクトサポートなど、最も広範な IDE ニーズをカバーします。」

もう一度読んでください。Mac 上の F# 開発者に対する Microsoft の公式な推奨は、Windows VM を動かすことです。これはクロスプラットフォームの物語ではありません。Windows こそがプラットフォームで、それ以外は回避策だと認めているだけです。

## C# Dev Kit は代替にはなっていない

Microsoft は Visual Studio for Mac を廃止したとき、代替として [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit) を示しました。しかし、コミュニティの評価は厳しいものです。

C# Dev Kit は [VS Marketplace において低いユーザー評価](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit)を受けています。Microsoft 自身のファーストパーティ拡張が、この評価です。最近のレビューは状況をよく表しています。

> 「そのままでは動かないし、基本的な調整をしても動かない。特に macOS や Linux では... LSP サーバーへの接続がクラッシュしてエラーを投げる。」 — DKchshv、2026 年 3 月

> 「インストール済みの .NET ランタイムを見つけられない。これは最初にできるべきことではないのか？」 — Emre Gönültaş、2026 年 2 月

> 「'Language server for Roslyn Copilot integration' というパッケージをインストールしている。私は Copilot 統合を頼んでいない。Copilot 統合は望んでいない。オプトインしたいか確認されてもいない。無効化する選択肢も提示されていない。ひどい商習慣だ。」 — Matt Kaczmarek、2026 年 4 月

そしてライセンスの問題があります。C# Dev Kit は [エンタープライズチームにとって無料ではありません](https://marketplace.visualstudio.com/items/ms-dotnettools.csdevkit/license)。250 人を超えるユーザー、または年間売上 100 万ドルを超える組織は「Enterprise」に分類され、**有料の Visual Studio サブスクリプションなしに C# Dev Kit を使って商用アプリケーションを開発できません**。オープンソース開発者は無料で使えます。商用チームはそうではありません。

信頼性とライセンス以外にも、機能差は現実です。C# Dev Kit には CPU プロファイラーがありません。メモリプロファイラーもありません。どのような種類のパフォーマンス分析ツールもありません。Visual Studio では中核的な IDE 機能であるものが、C# Dev Kit には存在しないのです。

新しい LSP ベース拡張のロードマップ発表が 2022 年に GitHub へ出たとき、コミュニティの反応は明確でした。[**1,035 件の thumbs-down リアクション**](https://github.com/dotnet/vscode-csharp/issues/5276)。これは、そのリポジトリ史上最も否定的な受け止められ方でした。Microsoft が新しいホストコンポーネントにクローズドソース部分を含めると明らかにした後のことです。怒りは不合理ではありませんでした。オープンソースプロジェクトである OmniSharp の上にワークフローを築いてきた開発者たちは、後継には中身を見られないプロプライエタリなコンポーネントが混ざると告げられたのです。

## Rider は優れている。しかし別世界です。

JetBrains Rider は本格的な IDE です。優れた F# サポート、クロスプラットフォーム対応、本物のプロファイラー、深い Roslyn 統合があります。IntelliJ 系 IDE に慣れていて、サブスクリプション料金を払うつもりがあるなら、Rider は有力な選択肢です。

しかし Rider は VS Code とはまったく別の開発環境です。VS Code を使う人、Neovim を使う人、Zed を使う人が混在するチームでは、Rider ベースのワークフローを共有できません。Rider の .NET インテリジェンスは Rider の中にあります。ほかのエディターが利用できる標準 LSP サーバーとして公開されていません。Rider を離れれば、そのツールも完全に置いていくことになります。

## F# は二級市民として扱われている

F# は業務アプリケーションにとって世界水準の言語です。強い型付け、代数的データ型、コンピュテーション式、そして本番環境に届く前に膨大な種類のバグを捕まえるコンパイラーがあります。金融システム、データパイプライン、ドメインの重いアプリケーションを構築する企業には、F# を選ぶ十分な理由があります。

しかしツールサポートは別の物語を語っています。

Visual Studio の F# サポートは C# に何年も遅れています。Rider はそれより良い状態です。VS Code の Ionide は、実際の制約の中で重要な仕事をしているコミュニティ管理の拡張です。しかし Microsoft からも、それ以外からも、すべてのエディターで F# ツールを C# と同じ地位に置くという物語はありません。F# はいつも後回しで、後付けで、C# のロードマップが埋まると延期される機能です。

Microsoft 自身の廃止発表も、このことをはっきり認めています。Visual Studio for Mac で失われるものを列挙したとき、F# は Windows VM を実行する理由として明示的に挙げられました。

## プラットフォームの問題

これらをすべて合わせると、.NET 開発体験は分断されています。

- **Windows**: Visual Studio を使う。最高水準のツールだが、プラットフォームに縛られる。
- **macOS/Linux で VS Code**: C# Dev Kit を使い、信頼性の問題を受け入れ、ライセンス制約を受け入れ、プロファイラーがないことを受け入れ、F# が二次的であることを受け入れる。
- **macOS/Linux で完全なツールが欲しい場合**: Rider を使い、サブスクリプション費用と、壁に囲まれたエコシステムであることを受け入れる。
- **Neovim、Helix、Zed、Emacs**: 公式サーバーが対象にしていないため、コミュニティが OmniSharp や clangd 風の構成から何とか組み合わせたものを受け入れる。

全体像を届ける、単一のオープンソース、クロスプラットフォーム、エディター非依存の .NET 言語サーバーは存在していません。

## SharpLsp が構築しているもの

SharpLsp は、インストール済みの `sharplsp-lsp` バイナリ 1 つを中心に構築されています。エディタークライアントはそれを `PATH` から見つけ、標準入力/標準出力で起動します。同じサーバーが C#、F#、ソリューション検出、セマンティック要求、診断、SharpLsp 独自要求を処理します。

アーキテクチャは意図的に分割されています。

- **Rust ホスト**が LSP 接続、仮想ファイルシステム、リクエストルーティング、tree-sitter による構文処理、sidecar のライフサイクルを担当します。
- **C# sidecar** が [Roslyn](https://github.com/dotnet/roslyn) をホストし、C# のセマンティック機能を提供します。
- **F# sidecar** が [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) をホストし、F# のセマンティック機能を提供します。
- **F# は後付けではありません。** 可能なところでは F# 機能を C# 機能より先に構築し、F# は初日から第一級の対象です。

だからこそ、VS Code 拡張は Solution Explorer とプロファイラービューを提供でき、その一方で同じ `sharplsp-lsp` が標準 LSP 機能だけをサポートするエディターにもサービスを提供できます。

alpha はまず VS Code の経路を堅牢にすることに集中しています。そこが正しい検証の場だからです。長期的な目標は、オープンソースの .NET ツールスタックを 1 つ、サーバーを 1 つ、すべてのエディターへ、そしてプロファイラー付きで届けることです。

## 実際にはどう見えるのか

エディター非依存の .NET LSP とは、次のようなものです。

- **C# と F# の言語インテリジェンス**を同じインストール済みサーバーから提供し、macOS、Linux、Windows で VM なしに動く。
- **座席単位のライセンスがない。** オープンソースで、Enterprise の例外条件もない。
- **動作するプロファイラー**がある。Visual Studio の中や Rider サブスクリプションの裏側に閉じ込められていない。
- VS Code、Zed、Neovim、Helix のどれを使っていても、**一貫した診断とナビゲーションのセマンティクス**がある。
- **F# を本来の言語として扱う。** C# が「終わる」まで延期される対象にしない。

.NET エコシステムは、Windows や 2.9 点の拡張、あるいは単一の商用 IDE ベンダーに人質にされるには優れすぎています。

## 基準は単純です

SharpLsp は、実際の .NET 作業を良くするかどうかで判断されるべきです。ソリューションを開く、コードを移動する、エラーを修正する、パッケージを管理する、実行中プロセスをプロファイルする、デバッグする。しかも、プロプライエタリなツールチェーンや Windows VM を強制されずに。

エディターは好みであるべきです。言語ツールはインフラであるべきです。
