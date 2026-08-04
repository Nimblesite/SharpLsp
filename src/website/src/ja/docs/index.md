---
layout: layouts/docs.njk
title: はじめに
lang: ja
eleventyNavigation:
  key: はじめに（日本語）
  order: 1
---

# SharpLsp を始める

SharpLsp は、1 つの Rust ホストから C# と F# のセマンティックエンジンを利用する、オープンソースの .NET 向け Language Server Protocol 実装です。プロプライエタリな言語サービスやユーザー単位のライセンスなしで、Visual Studio や Rider に匹敵するツールの実現を目指しています。現在も活発に開発されており、現時点でサポートされるエディター統合は VS Code です。

## インストール

### VS Code

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) から SharpLsp 拡張機能をインストールします。

VSIX には `sharplsp` ホストと両方の .NET サイドカーが同梱されています。Rust ツールチェーンや SharpLsp バイナリを別途用意する必要はありません。`.sln`、`.slnx`、`.csproj`、`.fsproj` のいずれかを含むワークスペースを開くと、拡張機能がサーバーを起動します。

<section class="callout">
  <h2>.NET の自動セットアップ</h2>
  <ul class="requirement-list">
    <li><span class="requirement-icon" aria-hidden="true">.NET</span><div><h3>.NET 10 SDK</h3><p>SharpLsp が MSBuild とコンパイラーサービスを利用するには SDK が必要です。アクティベーション時に、拡張機能が互換性のある SDK を検出するか、Microsoft の .NET Install Tool に取得を依頼します。言語サービスと F# Interactive は、<code>dotnet</code> があらかじめ PATH 上になくても、取得した SDK を使用できます。ビルド／テストコマンドと一部の NuGet 操作は、引き続き <code>dotnet</code> を名前で起動するため、PATH 上にあることが必要です。</p></div></li>
  </ul>
</section>

現在のリリースには、C# と F# の補完、ホバー、ナビゲーション、診断、シンボル、コードアクション、名前変更、セマンティックトークン、インレイヒントに加え、ソリューションツール、NuGet ワークフロー、デバッグ、プロファイリングが含まれます。一部の機能はまだ部分的な実装です。現在の制限事項は各ページで説明しています。

### その他のエディター

サーバーは可能な限り標準 LSP を使用しますが、Neovim、Zed、Rider、Helix、Emacs 向けのパッケージ化された統合はまだリリースされていません。

<p class="next-link"><a href="/ja/docs/architecture/">次へ: アーキテクチャ <span aria-hidden="true">→</span></a></p>
