---
layout: layouts/docs.njk
title: リファクタリングとコードアクション
description: "SharpLsp の C# と F# のクイックフィックスの使い方。インポートの追加、足りないコードの生成、F# パイプラインの変換、C# の型を別ファイルへの移動。"
lang: ja
eleventyNavigation:
  key: リファクタリングとコードアクション（日本語）
  order: 7
---

<img src="/assets/screenshots/docs/refactoring.webp" alt="不完全な F# の match に対するクイックフィックス" width="2400" height="1500">

# リファクタリングとコードアクション

ソリューションまたはプロジェクトを開いて読み込みが完了するのを待ち、エラーまたは宣言にカーソルを置きます。macOS では **Cmd+.**、Windows と Linux では **Ctrl+.** を押すとクイックフィックスが開きます。ほかの LSP エディターでは、コードアクションのメニューからこれらのアクションを利用できます。

{% video "refactoring-lesson" %}

## F# のクイックフィックス

| コンテキスト | アクション |
|---|---|
| 未解決の名前（`FS0039`） | 解決する `open` を追加するか、その箇所を修飾するか、適用できる `open type` を追加 |
| 未使用のバインディング（`FS1182`） | 名前の先頭に `_` を付ける |
| 破棄された結果（`FS0020`） | `\|> ignore` を追加 |
| 不完全な match（`FS0025`） | 不足しているユニオンケースを生成するか、ワイルドカードアームを追加 |
| 冗長なパターン（`FS0026`） | パターンを削除 |
| 対応している型の不一致（`FS0001`） | 既知の変換を挿入 |
| レコード式 | 不足しているフィールドを生成 |
| インターフェイスの実装 | メンバースタブを生成 |
| 未使用の `open` や修飾名 | インポートを削除するか、名前を簡略化 |

たとえば、次の不完全な match にカーソルを置いて **Generate 1 missing union case(s)** を選びます。

```fsharp
type Stage = Browsing | CheckedOut of decimal

let describe stage =
    match stage with
    | Browsing -> "still browsing"
```

SharpLsp は `| CheckedOut _ -> failwith "todo"` を追加します。生成された本体を自分の実装に置き換えてください。

対応している単一行の式では、メニューから `g a (f x)` を `x |> f |> g a` に（その逆方向にも）変換できます。利用できるアクションは、コンパイラーの診断とカーソル位置のコードによって変わります。現在の対応状況は [F# 言語サポート](/ja/docs/fsharp/)を参照してください。

## インポートの選択

インポートの修正は、適用前に何を変更するかを明示します。

| 意図 | F# | C# |
|---|---|---|
| 名前空間をインポート | `open System.Text` | `using System.Text;` |
| その箇所だけを修飾 | `System.Text.StringBuilder` | `System.Text.StringBuilder` |
| 型だけをインポート | 修飾名を使用 | `using StringBuilder = System.Text.StringBuilder;` |
| 静的メンバーと入れ子の型をインポート | `open type System.Math` | `using static System.Math;` |

`System.Text` をインポートせずに、F# で `let builder = StringBuilder()`、C# で `var builder = new StringBuilder();` を書いてみてください。`StringBuilder` でクイックフィックスを開くと、適用できる選択肢が表示されます。F# の `open type` には F# 5 以降が必要です。

対応している未解決の型では、メニューからソリューション内の同じ言語の別プロジェクト、または NuGet パッケージへの参照を追加することもできます。タイトルに参照先とインポートが示されます。パッケージの候補は、ソリューションですでに使われているパッケージか、SharpLsp の対応パッケージ一覧から取得されます。

## C# コードの生成

まだ存在しないメソッドへの呼び出しを書き、その名前でクイックフィックスを開きます。**Generate method** が、呼び出しから推論したパラメーターを持つスタブを作成します。現在の構文と選択範囲に対する C# の修正とリファクタリングは Roslyn が提供します。

## C# の型を移動する

宣言の名前でクイックフィックスを開きます。

| アクション | 結果 |
|---|---|
| **Move type to Receipt.cs** | ソースの隣にファイルを作成し、名前空間、インポート、ドキュメント、属性を保持する |
| **Move 'Inner' out of 'Outer' to Inner.cs** | 入れ子の型をトップレベルにし、ソリューション全体の参照を更新する |
| **Rename file to Receipt.cs** | ファイルを型の名前に合わせて改名する |

通常の移動では、partial で分割されたコンテナー宣言をまたいでも入れ子の型は入れ子のまま保たれます。取り出しのアクションは、名前の衝突、既存の移動先ファイル、アクセスできないコンテナーメンバーや外側の型パラメーターへの依存をチェックします。private の入れ子の型を取り出すと `internal` になります。

## アクションの適用

アクションを選ぶと編集が計算され、複数のファイルに影響することがあります。アクションの期限が切れている、または適用できない場合は、その理由が報告されます。参照のアクションは、まずインポートを適用してから参照を追加します。参照の追加に失敗した場合、エラーは元に戻すとインポートも取り消されることを説明します。

シンボルの名前変更は **F2** です。フォーマットには、C# 用の [CSharpier](https://csharpier.com/)、F# 用の [Fantomas](https://fsprojects.github.io/fantomas/) をインストールしてください。
