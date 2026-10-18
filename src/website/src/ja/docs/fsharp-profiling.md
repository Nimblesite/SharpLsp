---
layout: layouts/docs.njk
title: F# のプロファイリング
description: "SharpLsp で F# の CPU とメモリを VS Code でプロファイリング：.fs の行に付くヒートバー、名前で示されるクロージャーとパイプラインのステージ、組み立てた行に固定されるレコードと共用体ケース、リークを保持するモジュール値の特定。"
lang: ja
eleventyExcludeFromCollections: true
---

# F# のプロファイリング

SharpLsp の[プロファイラー](/ja/docs/profiler/)は言語ではなく .NET ランタイムにアタッチするため、F# のプログラムも C# と同じものをすべて得られます。ホットな行のヒートバー、フレームグラフ、ライブのヒープタイムライン、ランク付けされたリークの疑いです。さらに、F# コンパイラーが生成するコードを理解します。

- **クロージャーとパイプラインのステージ**は、コンパイラーが付けた名前のまま表示されるので、ホットなステージがその行を指し示します。
- **レコード、共用体、共用体ケース**は、それを組み立てる行に固定されます。コンパイラーがこれらの型に生成するメンバーには、独自のソース行がないためです。
- **モジュール値が保持するリーク**は、その値をソースに書いたとおりの名前で示します。

C# の Storefront デモの F# 版である FsStorefront での一連の流れを、VS Code で収録しました。早送りの部分は画面上に表示されます。

{% video "profiler-fsharp" %}

FsStorefront は注文のチェックアウトを延々と続けます。CSV のカタログを解析し、バスケットを選び、価格を計算し、`sprintf` で請求書を作ります。さらに、すべての顧客セッションを、誰も空にしないモジュールレベルの `Dictionary` に保持し続けます。

## F# コードの CPU プロファイリング

**Processes** ビューでアプリの行にカーソルを合わせて **Profile CPU** をクリックするか、**SharpLsp: Start Profiling** を実行します。遅い処理を走らせてから **Stop Profiling** をクリックします。`.fs` ファイルのホットな行すべてに、サンプルに占める割合を示すヒートバーが付きます。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-fsharp-heatmap.webp" alt="F# プログラムの CSV 解析、バスケットのシャッフル、割引の行にヒートバーが付いた Checkout.fs" width="2400" height="1500">
  <figcaption><code>Checkout.fs</code> のヒートマップ。ホットな行は、CSV 解析のパイプライン、バスケットのシャッフル、割引の fold です。</figcaption>
</figure>

結果パネルとフレームグラフは、各フレームをコンパイラーが生成したとおりの名前で表示します。

| F# のコード | 結果での表示 |
|---|---|
| モジュール関数 `let toProduct line = …` | `FsStorefront.Checkout.toProduct`：名前空間、モジュール、関数の順 |
| 24 行目のラムダ `fun p -> sprintf …` | `Checkout+lines@24.Invoke`：束縛先の値とその行 |
| 11 行目のパイプラインのステージ `… \|> Array.choose toProduct` | `Checkout+Pipe #1 stage #1 at line 11@11.Invoke` |
| `inline` 関数 | フレームなし：コンパイラーが本体を呼び出し元にコピーするため、その時間は呼び出し元のものになります |
| `List.map`、`Seq.fold` など FSharp.Core の関数 | `Microsoft.FSharp.Collections.ListModule.Map` など |

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-fsharp-results.webp" alt="F# プログラムの SharpLsp Profiler 結果パネル。フレームグラフと、モジュール、クロージャー、パイプラインのステージ名で示されたホット関数" width="2400" height="1500">
  <figcaption>結果パネル。各クロージャーとパイプラインのステージは、それを含む行にちなんだ名前で示されます。</figcaption>
</figure>

出荷するビルドをプロファイリングしてください。Debug ビルドはすべての呼び出しにフレームを残します。Release ビルドは小さな関数をインライン化し、F# コンパイラーは末尾呼び出しを生成するので、最後に別の関数を呼び出して終わる関数は、その下のスタックから消えることがあります。

## F# コードのメモリプロファイリング

行の **Track Memory** をクリックするか、**SharpLsp: Start Memory Tracking** を実行します。**SharpLsp Memory Dashboard** がコードの隣に開き、ヒープのタイムライン、上位の割り当てサイト、リークの疑いを表示します。`sharplsp.profiler.autoSnapshot` で定期的なスナップショットをオンにすると、ダッシュボードは増え続ける型を疑いとしてランク付けします。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-fsharp-leaks.webp" alt="F# のレコードと共用体ケースをリークの疑いとしてランク付けするメモリダッシュボード。隣の Sessions.fs では、それらを組み立てる行に紫のヒートバーが付いている" width="2400" height="1500">
  <figcaption>FsStorefront のリークの疑い。レコードと共用体ケースは、<code>Sessions.fs</code> でそれを組み立てる行に塗られます。</figcaption>
</figure>

### F# の型が塗られる場所

C# のクラスは宣言に塗られます。F# コンパイラーがレコードや共用体に生成するメンバーにはソース行がないため、SharpLsp はそれらの型を、プログラム内でその型を組み立てる行に塗ります。

| 型 | 塗られる場所 | ダッシュボードでの名前 |
|---|---|---|
| レコード `{ Order = order; Stage = stage; … }` | それを組み立てる行 | `FsStorefront.CustomerSession` |
| フィールドを持つ共用体ケース `CheckedOut order.Total` | それを組み立てる行 | `FsStorefront.Stage+CheckedOut`：フィールドを持つケースは、共用体に入れ子になったクラスです |
| 単一ケースの共用体 `CustomerId 42` | それを組み立てる行 | `FsStorefront.CustomerId` |
| ジェネリックなレコード | それを組み立てる行 | ``Tagged`1[System.Int32]`` のように型引数を含む名前 |
| クロージャーや匿名レコード | それを組み立てる行 | コンパイル後の名前 |
| 独自のメンバーを持つクラス | 最初のメンバー | `FsStorefront.PriceTicker` |
| 構造体のレコードや共用体（`[<Struct>]`） | なし：保持するオブジェクトの中に格納されるので、単独では現れません | 表示されない |
| `Browsing` のようなフィールドのない共用体ケース | なし：すべての使用で 1 つのインスタンスを共有するので、増えません | 表示されない |
| 配列、F# のリスト、その他の FSharp.Core やフレームワークの型 | なし：プロジェクト内にソースがありません | ``FSharpList`1[FsStorefront.Product]`` のように名前だけ |

ダッシュボードの疑いをクリックすると、その行にジャンプします。

### 何が生かし続けているか：モジュール値

**SharpLsp: Show Reference Graph** を実行して疑いの型を選ぶと、その型を保持するオブジェクトと、それらを生かし続けるルートが表示されます。`let private sessions = Dictionary<int, CustomerSession>()` のようなモジュール値は、行番号付きの名前の静的フィールド `sessions@6` にコンパイルされます。グラフはそのルートを、書いたとおりに `static sessions` と表示します。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-fsharp-graph.webp" alt="FsStorefront.CustomerSession の保持グラフ：モジュール値 static sessions をルートとする Dictionary が保持するセッション" width="2400" height="1500">
  <figcaption>すべての <code>CustomerSession</code> は 1 つの <code>Dictionary</code> にぶら下がり、そのルートはモジュール値 <code>sessions</code> です。</figcaption>
</figure>

FsStorefront に必要なのは最近のセッションだけなので、修正では直近 1,000 件の枠を保ちます。

```fsharp
// Remembers the last 1,000 orders "for analytics", and forgets older ones.
let private sessions = Dictionary<int, CustomerSession>()

let remember order =
    let stage = CheckedOut order.Total
    sessions[order.Id] <- { Order = order; Stage = stage; Snapshot = Array.zeroCreate 4096 }
    sessions.Remove(order.Id - 1_000) |> ignore
```

再ビルドしてもう一度追跡すると、ヒープは横ばいになり、Low を超える疑いはありません。[メモリリークの直し方](/ja/docs/memory-leaks/)では、イベントハンドラーやクロージャーの F# での修正と F# のリークテストを含め、この流れ全体を解説しています。

## 関連

- [プロファイラー](/ja/docs/profiler/)：プロファイラーのすべてのコマンドと設定
- [メモリリークの直し方](/ja/docs/memory-leaks/)：C# と F# でのリーク修正の手順
- [F# 言語サポート](/ja/docs/fsharp/)：SharpLsp が F# のためにできるその他すべて
