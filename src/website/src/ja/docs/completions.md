---
layout: layouts/docs.njk
title: コード補完
lang: ja
eleventyNavigation:
  key: コード補完（日本語）
  order: 4
---

![VS Code でのコード補完](/assets/screenshots/vscode-completions-page.png)

# コード補完

SharpLsp は C# と F# の両方でセマンティック補完を提供します。Rust ホストが各リクエストを Roslyn または F# Compiler Service（FCS）にルーティングし、置換範囲を含む標準の LSP 補完項目を返します。

## C# の補完

C# の補完には Roslyn の `CompletionService` を使用します。メンバー、型、名前空間、ローカル変数、パラメーター、コンテキストキーワードなど、カーソル位置で Roslyn が提供するシンボルとキーワードを補完します。

各項目にはテキスト編集が含まれるため、補完を確定すると現在の識別子に追記するのではなく、その識別子を置き換えます。`completionItem/resolve` は Roslyn に最終的な変更を問い合わせ、追加の編集があればそれも返します。インポート補完の場合、その編集によって必要な `using` ディレクティブを追加できます。

## F# の補完

F# の補完には FCS の `GetDeclarationListInfo` を使用します。メンバーとスコープ内のシンボルの補完に対応しており、確定した項目は現在のトークンを正しく置き換えます。

FSAC と同等にするため、次の 2 つの課題が残っています。

- 開かれていない名前空間のシンボルは、まだ一覧に追加されません。
- `completionItem/resolve` は実装されていますが、まだ `open` 宣言を挿入しません。

## 補完のトリガー

SharpLsp は、両方の言語でメンバーアクセス時に補完を自動的にトリガーする文字として `.` を通知します。エディターから補完を明示的に要求することもできます。たとえば VS Code では `Ctrl+Space` を使用します。

`(` や `,` などの文字は補完ではなくシグネチャーヘルプに属し、別途通知されます。

## LSP ケイパビリティ

```json
{
  "completionProvider": {
    "resolveProvider": true,
    "triggerCharacters": ["."]
  }
}
```

補完結果は、現在の未保存のバッファーから計算されます。該当する言語のサイドカーが無効または利用できない場合、SharpLsp は結果を捏造せず、セマンティック補完項目を返しません。
