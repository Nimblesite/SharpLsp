---
layout: layouts/docs.njk
title: アーキテクチャ
lang: ja
eleventyNavigation:
  key: アーキテクチャ（日本語）
  order: 2
---

# アーキテクチャ

![VS Code で表示した SharpLsp のアーキテクチャ](/assets/screenshots/vscode-architecture-page.png)

SharpLsp は、軽量な構文処理と豊かなセマンティック解析を分離する 3 層アーキテクチャで構築されています。

## 第 1 層 — Rust LSP ホスト

ホストプロセスは次を担当します。

- **LSP プロトコル**: stdio 上の JSON-RPC。LSP 3.17 の動作を対象にします
- **仮想ファイルシステム（VFS）**: 変更追跡付きのメモリ上ファイル状態
- **tree-sitter 解析**: サブミリ秒級のインクリメンタル C# 解析。F# 文法統合は進行中で、F# の構文機能はサイドカーへルーティングされます
- **salsa キャッシュ**: インクリメンタル計算。変更されたものだけを再処理します
- **リクエストルーティング**: 高速な構文リクエストは Rust に残し、セマンティックリクエストはサイドカーへ送ります

## 第 2 層 — C# サイドカー（Roslyn）

長時間動作する .NET 10 プロセスで、次を提供します。

- ソリューションとプロジェクトを読み込む MSBuildWorkspace
- Roslyn ベースの C# 機能: 補完、診断、コードアクション、リファクタリング
- 逆コンパイル済みソースへの移動に使う ICSharpCode.Decompiler
- 名前付きパイプ / Unix ドメインソケット上の MessagePack シリアライズ

## 第 3 層 — F# サイドカー（FCS）

F# サポート用の独立した .NET 10 プロセスです。

- 型チェックと解析を行う FSharpChecker
- プロジェクトシステム統合のための Ionide.ProjInfo
- 追加診断のための FSharpLint

## IPC プロトコル

Rust ホストと .NET サイドカーの通信には次を使います。

- **MessagePack** バイナリシリアライズ（小さく高速）
- **名前付きパイプ**（Windows）または **Unix ドメインソケット**（Linux、macOS）
- **4 バイト little-endian 長プレフィックス**フレーミング
- 目標: 往復オーバーヘッド <500µs

## リクエストルーティング

| カテゴリ | ハンドラー | レイテンシ目標 | 例 |
|----------|------------|----------------|----|
| 構文のみ | Rust (tree-sitter) | <5ms | documentSymbol、foldingRange |
| セマンティック | サイドカー | <200ms | completion、hover、definition |
| ハイブリッド | Rust + サイドカー | <100ms | semanticTokens |
| キャッシュ済み | Rust (salsa) | <1ms | 変更されていない文書への繰り返しリクエスト |
