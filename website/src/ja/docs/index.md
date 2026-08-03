---
layout: layouts/docs.njk
title: はじめに
lang: ja
eleventyNavigation:
  key: はじめに（日本語）
  order: 1
---

# SharpLsp を始める

SharpLsp は Rust で構築された、オープンソースの .NET（C# + F#）向け Language Server Protocol（LSP）実装です。1 つのサーバーで、どのエディターでも動作します。Visual Studio、Rider、C# Dev Kit と完全に同等の機能を提供し、プロプライエタリな依存関係も、ライセンスも、ベンダーロックインもありません。

## インストール

### VS Code

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) から SharpLsp 拡張機能をインストールします。

拡張機能には `sharplsp` バイナリと両方のサイドカーが VSIX 内に同梱されています。Rust ツールチェーンは不要です。別途バイナリをインストールする必要もありません。`.sln` または `.csproj` を開くと、SharpLsp が自動的に起動します。

<section class="callout">
  <h2>前提条件</h2>
  <ul class="requirement-list">
    <li><span class="requirement-icon" aria-hidden="true">.NET</span><div><h3>.NET 10.0 SDK</h3><p>プロジェクトの解析と MSBuild 連携に必要です。<code>dotnet</code> が PATH 上にあることを確認してください。</p></div></li>
  </ul>
</section>

### Neovim と Zed

Neovim と Zed のサポートは近日公開予定です。

<p class="next-link"><a href="/ja/docs/architecture/">次へ: アーキテクチャ <span aria-hidden="true">→</span></a></p>
