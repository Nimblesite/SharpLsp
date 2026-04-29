---
layout: layouts/docs.njk
title: 定義へ移動
lang: ja
eleventyExcludeFromCollections: true
---

![VS Code での定義へ移動](/assets/screenshots/vscode-go-to-definition-page.png)

*Alpha 版 VS Code 拡張機能での C# 定義ナビゲーション。*

# 定義へ移動

SharpLsp は Roslyn サイドカーの上に LSP の定義ナビゲーション群を構築しています。現在の拡張機能は VS Code ワークフローを公開しており、エッジケースは引き続き強化中です。

## ナビゲーションメソッド

| LSP メソッド | ショートカット（VS Code） | 説明 |
|--------------|----------------------------|------|
| `textDocument/definition` | `F12` | シンボルの宣言へ移動 |
| `textDocument/typeDefinition` | `Ctrl+F12` | シンボルの型へ移動 |
| `textDocument/declaration` | — | インターフェイス / abstract 宣言へ移動 |
| `textDocument/implementation` | `Ctrl+Shift+F12` | すべての具象実装へ移動 |

ナビゲーション群は SharpLsp のリリース上重要な領域です。Alpha 版では、依存する操作とプロジェクト構成ごとに挙動を確認してください。

## C# ナビゲーション（Roslyn）

### textDocument/definition

Roslyn は `SemanticModel.GetSymbolInfo()` でシンボルを解決し、`ISymbol.Locations` からソース位置を返します。

### textDocument/implementation

`SymbolFinder.FindImplementationsAsync()` を使って、ソリューション全体からすべての具象実装を探します。複数ある場合（例: 10 個の実装クラスを持つインターフェイス）は `Location[]` を返します。

### 特殊ケース

| シンボル | `definition` | `typeDefinition` | `declaration` | `implementation` |
|----------|--------------|------------------|---------------|------------------|
| 変数（`var x = new Foo()`） | 変数宣言 | `Foo` クラス | definition と同じ | — |
| メソッド呼び出し（`bar.Baz()`） | メソッド本体 | 戻り値型 | インターフェイス / abstract メソッド | すべての override |
| インターフェイスメンバー | インターフェイス宣言 | メンバー戻り値型 | 同じ | すべての実装クラス |
| override メソッド | override 位置 | 戻り値型 | 基底 virtual / abstract | すべての同階層 override |
| コンストラクター（`new Foo()`） | コンストラクター宣言 | `Foo` クラス | 同じ | — |
| partial クラス / メソッド | 最初の `partial` 宣言 | 型 | 定義側 partial | すべての partial 部分 |

### 逆コンパイル済みソースへの移動

シンボルが参照アセンブリ（NuGet パッケージ、BCL）内で定義されている場合、SharpLsp は [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy) を使って対象型をオンデマンドで逆コンパイルします。逆コンパイル済みソースは読み取り専用バッファーで開かれるため、フレームワーク内部にも移動できます。

```csharp
// List<T>.Add() を Ctrl+クリックすると逆コンパイル済み内容へ移動:
// public void Add(T item) {
//     if (_size == _items.Length) EnsureCapacity(_size + 1);
//     _items[_size++] = item;
//     _version++;
// }
```

## キャッシュ

すべての定義結果は `(document_uri, version, position, method)` をキーとして salsa にキャッシュされます。キャッシュヒットは 1ms 未満で返ります。`method` コンポーネントにより、同じ位置に対する `definition`、`typeDefinition`、`declaration`、`implementation` を区別します。

## パフォーマンス目標

| 指標 | 目標 |
|------|------|
| 定義レイテンシ（p50） | <100ms |
| 定義レイテンシ（p95） | <250ms |
| キャッシュ済み定義 | <1ms |
| 実装検索（100 実装） | <500ms |
