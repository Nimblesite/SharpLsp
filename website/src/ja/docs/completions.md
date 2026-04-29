---
layout: layouts/docs.njk
title: コード補完
lang: ja
eleventyNavigation:
  key: コード補完（日本語）
  order: 4
---

![VS Code でのコード補完](/assets/screenshots/vscode-completions-page.png)

*Alpha 版 VS Code 拡張機能で Roslyn により提供される C# 補完。*

# コード補完

SharpLsp は Roslyn を通じて C# のコード補完を提供します。補完は C# サイドカーへルーティングされるため、Rust ホストは高速な構文処理に集中できます。

## パフォーマンス目標

| 指標 | 目標 |
|------|------|
| p50 レイテンシ | <100ms |
| p95 レイテンシ | <200ms |
| キャッシュ済み（未変更文書） | <1ms |

## C# 補完（Roslyn）

C# サイドカーは Roslyn の `CompletionService` を使って補完候補を生成します。この機能は、.NET ツールエコシステムで広く使われる同じコンパイラープラットフォーム上に構築されています。

### 補完されるもの

- **型と名前空間** — クラス、インターフェイス、構造体、列挙型、デリゲート
- **メンバー** — メソッド、プロパティ、フィールド、イベント、インデクサー
- **キーワード** — コンテキストに応じて正しく絞り込まれた C# キーワード
- **スニペット** — `for`、`foreach`、`if`、`try` などの一般的なコードパターン
- **インポート補完** — 参照済みアセンブリ内にある、まだ `using` されていない型
- **override 補完** — 実装すべき abstract / virtual メンバー
- **XML ドキュメント補完** — `///` トリガーで `<summary>`、`<param>` などを補完
- **`var` 推論** — 補完ツールチップに推論された型を表示

### トリガー文字

補完は次の文字の後に自動トリガーされます。

| 文字 | コンテキスト |
|------|--------------|
| `.` | メンバーアクセス |
| `(` | パラメーターヒント |
| `<` | ジェネリック型引数 |
| `[` | 配列インデクサー、属性 |
| `{` | オブジェクト初期化子 |
| ` ` | キーワード補完 |
| `@` | 逐語的識別子 |

### インポート補完

まだ `using` でインポートされていない型は、補完リストに淡い表示で現れます。選択すると、ファイル先頭に正しい `using` ディレクティブが自動追加されます。

```csharp
// 変更前: JsonSerializer の using がない
var json = JsonSerializer.Serialize(obj);
//         ↑ 補完が追加: using System.Text.Json;
```

## LSP プロトコル

SharpLsp は次を通知します。

```json
{
  "completionProvider": {
    "resolveProvider": true,
    "triggerCharacters": [".", "(", "<", "[", "{", " ", "@"]
  }
}
```

`completionItem/resolve` に対応しています。完全なドキュメントや追加編集（例: import の挿入）は resolve 時に追加されるため、初期リストを高速に返せます。
