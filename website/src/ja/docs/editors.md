---
layout: layouts/docs.njk
title: エディター設定
lang: ja
eleventyNavigation:
  key: エディター設定（日本語）
  order: 3
---

# エディター設定

![SharpLsp のエディター対応を VS Code で表示](/assets/screenshots/vscode-editors-page.png)

SharpLsp は LSP レイヤーではエディター非依存です。VS Code 拡張機能が主な対応サーフェスです。Neovim と Zed のサポートは近日公開予定です。

**前提条件:** [.NET 10.0 SDK](https://dotnet.microsoft.com/download) をインストールし、`dotnet` が PATH 上で実行できるようにしてください。

## VS Code

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sharplsp.sharplsp) から SharpLsp 拡張機能をインストールします。拡張機能には `sharplsp` バイナリと両方のサイドカーが VSIX 内に同梱されています。Rust ツールチェーンや別途バイナリのインストールは不要です。

拡張機能は `sharplsp` サーバーのライフサイクルを自動管理し、ソリューションエクスプローラー、プロファイラー、NuGet ブラウザー、テストレンズ、エディター状態連携を提供します。追加設定は不要です。

## Neovim

近日公開予定です。

## Zed

近日公開予定です。
