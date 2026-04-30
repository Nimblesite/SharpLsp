---
layout: layouts/docs.njk
title: コントリビュート
lang: ja
eleventyNavigation:
  key: コントリビュート（日本語）
  order: 13
---

# コントリビュートとソースからのビルド

このページは、SharpLsp をソースからビルドしたいコントリビューター向けです。SharpLsp を利用したいだけであれば、VS Code 拡張機能をインストールしてください — 必要なものはすべて同梱されています。

## 前提条件

- **Rust**（stable、最新版） — [rustup](https://rustup.rs) からインストール
- **.NET 10.0 SDK** — [ダウンロード](https://dotnet.microsoft.com/download)
- **Node 20** — VS Code 拡張機能用

## 推奨: Dev Container

最も手早い方法は、同梱の dev container を使うことです。Rust、.NET 10 SDK、Node 20、必要なツール一式が事前構成されています。

1. [Docker](https://www.docker.com/) と [Dev Containers 拡張機能](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) をインストールします
2. リポジトリを VS Code で開きます
3. プロンプトが表示されたら **Reopen in Container** をクリックします

## 手動セットアップ

```sh
# Rust LSP ホストをビルド
cargo build

# clippy lint を実行
cargo clippy

# テストを実行
cargo test

# VS Code 拡張機能の VSIX をビルド
cd editors/vscode && npm install && npm run compile
```

## リポジトリ構成

```
sharplsp/
├── src/                  # Rust LSP ホスト
├── sidecars/
│   ├── SharpLsp.Sidecar.FSharp/   # F# サイドカー（FSharp.Compiler.Service）
│   ├── SharpLsp.Sidecar.CSharp/   # C# サイドカー（Roslyn）
│   └── SharpLsp.Sidecar.Common/   # サイドカー共有コード
├── editors/
│   ├── vscode/           # VS Code 拡張機能（TypeScript）
│   └── zed/              # Zed 拡張機能（Rust → wasm32-wasip1）
├── docs/                 # 仕様書と実装計画
├── tests/                # E2E テスト
└── website/              # このサイト
```

## アーキテクチャ

3 層アーキテクチャ:

- **第 1 層 — Rust LSP ホスト**: LSP 接続（stdio 上の JSON-RPC）、VFS、tree-sitter インクリメンタル解析、リクエストルーティング、サイドカーライフサイクル
- **第 2 層 — C# サイドカー（Roslyn）**: MSBuildWorkspace、Roslyn API 全機能（補完、診断、リファクタリング、整形）
- **第 3 層 — F# サイドカー（FCS）**: FSharp.Compiler.Service、Fantomas、FSharpLint

IPC は名前付きパイプ（Windows）/ Unix ドメインソケット（Linux、macOS）上の MessagePack を使用します。

詳細は [アーキテクチャ](/ja/docs/architecture/) を参照してください。

<p class="next-link"><a href="/ja/docs/architecture/">次へ: アーキテクチャ <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span></a></p>
