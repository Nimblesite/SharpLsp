---
layout: layouts/docs.njk
title: はじめに
lang: ja
eleventyNavigation:
  key: はじめに（日本語）
  order: 1
---

# SharpLsp を始める

SharpLsp は Rust で構築された、オープンソースの .NET（C# + F#）向け Language Server Protocol（LSP）実装です。1 つのサーバーで、どのエディターでも動作します。Visual Studio、Rider、C# Dev Kit と同等の機能を目指しながら、プロプライエタリな依存関係、ライセンス、ベンダーロックインをなくします。

<img src="/assets/screenshots/vscode-getting-started-page.png" alt="" aria-hidden="true" style="position:absolute;width:1px;height:1px;opacity:0;margin:0;border:0;">

<section class="callout">
  <h2><span class="material-symbols-outlined" aria-hidden="true">fact_check</span>前提条件</h2>
  <ul class="requirement-list">
    <li>
      <span class="material-symbols-outlined" aria-hidden="true">deployed_code</span>
      <div>
        <h3>.NET 10.0 SDK</h3>
        <p>プロジェクトの解析と MSBuild 連携に必要です。<a href="https://dotnet.microsoft.com/download">microsoft.com/download</a> からインストールし、<code>dotnet</code> が PATH 上で実行できることを確認してください。</p>
      </div>
    </li>
  </ul>
</section>

## インストール

### VS Code

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sharplsp-lsp.sharplsp) から SharpLsp 拡張機能をインストールします。

拡張機能には <code>sharplsp-lsp</code> バイナリと両方のサイドカーが VSIX 内に同梱されています。Rust ツールチェーンは不要です。別途バイナリをインストールする必要もありません。<code>.sln</code> または <code>.csproj</code> を開くと、SharpLsp が自動的に起動します。

### Neovim と Zed

Neovim と Zed のサポートは近日公開予定です。

<p class="next-link"><a href="/ja/docs/architecture/">次へ: アーキテクチャ <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span></a></p>
