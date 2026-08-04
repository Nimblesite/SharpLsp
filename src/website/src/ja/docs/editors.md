---
layout: layouts/docs.njk
title: エディター設定
lang: ja
eleventyNavigation:
  key: エディター設定（日本語）
  order: 3
---

# エディター設定

![SharpLsp のエディター対応](/assets/screenshots/vscode-editors-page.png)

SharpLsp はプロトコル層ではエディターに依存しません。現時点でサポートされ、パッケージとして提供されているクライアントは VS Code です。その他の統合は開発中です。

## VS Code

SharpLsp は [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) からインストールします。VSIX には Rust ホストと C#／F# サイドカーが含まれるため、SharpLsp を別途インストールする必要はありません。

アクティベーション時に、拡張機能は次を行います。

1. 互換性のある .NET 10 SDK を検出するか、Microsoft の .NET Install Tool を使って取得する
2. 同梱バイナリのうち、現在のプラットフォーム向けのものを特定する
3. 言語クライアントとサイドカーを起動する
4. ワークスペース内のソリューションまたはプロジェクトを検出する

拡張機能は、ソリューションエクスプローラー、NuGet ブラウザー、プロファイラー、デバッガー統合、テスト CodeLens、F# Interactive コマンド、ビルドコマンド、ステータス／出力ビューも提供します。

### ワークスペースの信頼

信頼されていないワークスペースでは、SharpLsp は同梱されたバイナリだけを実行します。`sharplsp.lspPath`、サイドカーのパス、追加のサーバー引数、FSI 引数、デバッグアダプターのパスなど、実行ファイルの選択や引数の挿入に使えるワークスペース設定は、ワークスペースが信頼されるまで無視されます。

### 開発用カスタムバイナリ

信頼されたワークスペースでは、`sharplsp.lspPath`、`sharplsp.csharpSidecarPath`、`sharplsp.fsharpSidecarPath` の各設定で、ローカルの開発ビルドを拡張機能に指定できます。同梱されたリリースバイナリを使う場合は空のままにしてください。

## その他の LSP クライアント

一般的なエディターは、stdio を介してホストと LSP 3.17 で通信できます。ただし SharpLsp は、ホストと両方のサイドカーをそれらのクライアント向けに配置する、サポート対象のスタンドアロンインストール手順をまだ公開していません。Zed、Neovim、Rider、Helix、Emacs との統合は計画中であり、現在のリリース対象ではありません。

リポジトリからビルドする方法は、[コントリビュート](/ja/docs/contributing/)を参照してください。
