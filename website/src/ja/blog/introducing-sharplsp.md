---
layout: layouts/blog.njk
title: "SharpLsp を発表します：Rust で構築された .NET LSP"
description: "SharpLsp は C# と F# のためのオープンソースのエディター非依存言語サーバーです。Rust で構築し、Roslyn と FSharp.Compiler.Service を活用。ライセンスなし、ベンダーロックインなし、あらゆるエディターで動作します。"
lang: ja
date: 2026-03-20
author: Christian Findlay
image: /assets/images/blog/introducing-sharplsp.png
imageAlt: Rust ホストエンジンと C# / F# サイドカーモジュールの構成図
tags:
  - posts
  - announcement
  - rust
  - csharp
  - fsharp
category: announcement
excerpt: "私たちは Microsoft が .NET ツールを修正するのを待つことに終止符を打ちました。SharpLsp はその答えです。Rust をホストに採用した LSP サーバーで、すべてのエディターに対して C# と F# の第一級サポートを提供します。プロプライエタリな依存関係ゼロ。"
---

私たちは待つことに疲れました。

Windows 以外での .NET 開発者体験は壊れています。理論的にではなく、実際に、公の場で実証されています。Microsoft のクローズドソースツール発表に対するコミュニティの 12 対 1 の拒絶反応と、Mac 開発者に Windows を VM で実行するよう告げた引退投稿がその証拠です。SharpLsp はコミュニティの答えです。C# と F# のためのオープンソースのエディター非依存言語サーバー — Rust で構築し、[Roslyn](https://github.com/dotnet/roslyn) と [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) を活用しています。MIT ライセンス。プロプライエタリな依存関係ゼロ。1 回のインストールでマシン上のすべてのエディターに対応します。

## 状況はあなたが思っているより深刻です

今日 .NET 開発者が利用できるすべての選択肢には、致命的な欠陥があります。癖ではなく、パッチでは修正できない構造的な問題です。

### Visual Studio：Windows のみ、以上

Visual Studio は Windows 専用です。2023 年 8 月、Microsoft は Visual Studio for Mac の廃止を発表しました。[公式の廃止発表](https://devblogs.microsoft.com/visualstudio/visual-studio-for-mac-retirement-announcement/)には、F# が必要な Mac 開発者向けの代替手段として次のような記述がありました。

> **「Mac 上の VM で Windows 版 Visual Studio IDE を実行する：このオプションは、Xamarin、F#、iOS のリモート開発体験のようなレガシープロジェクトサポートなど、最も広範な IDE ニーズをカバーします。」**

これは回避策ではありません。これは Microsoft が F# の Mac 開発者に対して、自分の言語でコードを書くために外国のオペレーティングシステムをコンピューター内で実行するよう告げているのです。

### C# Dev Kit：クローズドコア、エンタープライズペイウォール、VS Code のみ

代替として Microsoft が提示したのは [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit) でした。しかしコミュニティの評価は厳しいものです。

C# Dev Kit は VS Marketplace でユーザー評価が低く、初期セットアップや macOS / Linux での安定性に関する不満がレビューで繰り返し報告されています。

ライセンスの問題もあります。[C# Dev Kit のライセンス](https://marketplace.visualstudio.com/items/ms-dotnettools.csdevkit/license)には厳しいエンタープライズ制限があり、250 名を超えるユーザーまたは年間売上 100 万ドルを超える組織は、有料の Visual Studio サブスクリプションなしに商用アプリケーションを開発するために拡張機能を使用できません。

C# Dev Kit は **VS Code 専用**でもあります。Neovim、Helix、Emacs、Zed、その他の LSP 対応エディターでは動作しません。

### OmniSharp：コミュニティの孤児

OmniSharp は長年、オリジナルの C# 拡張機能を動かしてきたオープンソースの縁の下の力持ちでした。エディター間で動作し、MIT ライセンスで、コミュニティによって維持されていました — 理論上は。実際には、OmniSharp の継続的な健全性は Microsoft 社員が優先するかどうかにかかっています。それは独立ではなく、コミュニティの顔をした依存です。

### Rider：優れているが、プロプライエタリ

JetBrains Rider は .NET 向けに Visual Studio 以外で利用できる最高の IDE です。これは本心からの賛辞です。しかし Rider は有料の商用ライセンスが必要です。クローズドソースです。あなたのワークフローは JetBrains がそれを商業的に維持し、有利な価格設定を続けることに依存しています。

オープンエコシステムには、プロプライエタリな IDE は永続的な答えではありません。.NET ランタイムはオープンです。C# コンパイラーはオープンです。F# コンパイラーはオープンです。Language Server Protocol はオープンです。エディターツールもオープンであるべきです。

## 私たちが構築したもの

SharpLsp は約束ではありません。動作するソフトウェアです。VS Code 拡張機能が最初のエディター統合ですが、アーキテクチャは最初からエディター非依存になるよう意図的に設計されています — `$PATH` 上の単一の `sharplsp` バイナリで、LSP 対応のあらゆるエディターが起動できます。

重要なアーキテクチャの洞察は、コンパイラーがすでに知っていることを再実装しないということです。私たちはコンパイラーを呼び出します。C# には Roslyn。F# には FSharp.Compiler.Service。補完、診断、ホバー、定義ジャンプ、リネームなど、セマンティックなものはすべて、薄い IPC ブリッジを通じて実際のコンパイラーから来ます。

## アーキテクチャ

SharpLsp は 3 層システムです。Rust ホストが LSP 接続、仮想ファイルシステム、[tree-sitter](https://tree-sitter.github.io/tree-sitter/) によるすべての構文レベルの作業を担当します。2 つの長期実行 .NET サイドカープロセスがセマンティック分析を処理します — C# には Roslyn、F# には FSharp.Compiler.Service。

Rust でホストを構築する決定は目新しさのための選択ではありません。Rust は tokio によるゼロコスト非同期ランタイム、マルチエディターの共有サーバーシナリオのための安全な並行性、50 ms 以内に起動しサイドカーが接続される前にほぼメモリを消費しないバイナリを提供します。

IPC は Unix ドメインソケット（Windows では名前付きパイプ）上の MessagePack を使用し、4 バイトのリトルエンディアン長プレフィックスでフレーミングされています。ローカルベンチマークでの IPC ラウンドトリップオーバーヘッドは一貫して 200µs 未満であり、ボトルネックは常にコンパイラー操作 — トランスポートではありません。

## 次のステップ

SharpLsp のフルソースは [GitHub](https://github.com/Nimblesite/SharpLsp) にあります。

SharpLsp は .NET 開発者がプロプライエタリなライセンス、ベンダーロックイン、または単一エディターの結合の背後にゲートされない世界水準のツールを受けるに値するから存在しています。コミュニティは 10 年以上回避策を構築してきました。私たちは回避策を構築することをやめました。本物を一緒に構築しましょう。
