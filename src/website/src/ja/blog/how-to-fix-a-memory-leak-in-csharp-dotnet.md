---
layout: layouts/blog.njk
title: "C# と .NET のメモリリークを修正する方法：ステップバイステップ"
description: "VS Code で C# と .NET のメモリリークを順を追って見つけて修正する方法：無料の .NET メモリプロファイラーによるメモリリーク検出、原因を示す保持グラフ、修正、そしてイベント、Dispose、タイマー、依存性の注入が原因の C# のメモリリーク。"
lang: ja
date: 2026-10-17
author: SharpLsp チーム
image: /assets/images/blog/how-to-fix-a-memory-leak-in-csharp-dotnet.png
imageAlt: VS Code で追跡した C# のメモリリーク。上昇し続けるヒープのタイムラインから、すべての CustomerSession を保持する静的な Dictionary まで
tags:
  - posts
  - profiling
  - memory-leaks
  - csharp
  - fsharp
category: profiling
excerpt: "「fix memory leak」はメモリについて最も多く検索される言葉で、2 年で 2 倍以上になりました。VS Code で収録した C# のメモリリークの修正の全工程です。上昇に気づき、疑いを順位付けし、ルートを見つけ、直して確かめます。"
---

「fix memory leak」はメモリについて最も多く検索される言葉で、2024 年から 2026 年にかけて 2 倍以上になりました。そのすぐ後に「what is a memory leak」と「how to fix a memory leak」が続きます。たいていの答えは「メモリプロファイラーを使おう」で終わってしまいます。この記事では、実際の C# のメモリリークを最後まで追います。見つけて、ルートまでたどり、直して、その修正を確かめる。すべて VS Code の中で、無料の SharpLsp メモリプロファイラーを使って行います。

VS Code で収録した一連の流れです。早送りの部分は画面上に表示されます。

{% video "profiler-fix-memory-leak" %}

## C# のメモリリークとは？

C# にはガベージコレクションがあり、.NET ランタイムはもう何からも参照されていないオブジェクトをすべて解放します。つまり C# のメモリリークとは、解放し忘れたメモリではなく、何かがまだ保持しているオブジェクトです。静的なリスト、イベント、長寿命のサービスが参照を持ち続けるので、ガベージコレクターは決してそれを解放できず、アプリが動いている限りメモリは上がり続けます。

## リーク

Storefront デモアプリはループで注文の会計を続けます。その `SessionCache` はすべての注文を「分析のために」記憶し、何も削除しない静的な `Dictionary` に入れます。

```csharp
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order) => Sessions[order.Id] = new CustomerSession(order);
}
```

各 `CustomerSession` は 4 KB のバッファーを持っています。そして、それを手放すものは何もありません。

## ステップ 1：上昇に気づく

SharpLsp ビューを開きます。**Processes** にはマシン上のすべての .NET プロセスがリアルタイムの CPU とメモリとともに並びます。Storefront のメモリは上がる一方です。上がったり下がったりするメモリは通常のガベージコレクションです。一定の負荷で上がる一方のメモリは、リークの候補です。

## ステップ 2：メモリを追跡する

Storefront の行にカーソルを合わせて **Track Memory** をクリックします。メモリダッシュボードがコードの横に開き、ヒープのスナップショットを撮り始め、それぞれを直前のものと比較します。ヒープのタイムラインはスナップショットのたびに上がっていきます。

## ステップ 3：リークの疑いを読む

スナップショットで増えた型は疑いになります。2 回連続で増えると Medium、3 回で High です。数回のスナップショットで、`CustomerSession` とそれが保持するバイト配列、注文、商品のリストのすべてが High になり、どのスナップショットでも一貫して増えています。エディターでは `CustomerSession` の宣言に、増加量とともに `HIGH` のリークマーカーが付きます。疑いをクリックすると、エディターがそこへジャンプします。

## ステップ 4：何が生かし続けているかを見つける

増加は*何が*リークしているかを教えてくれます。修正には*なぜ*が必要です。**SharpLsp: Show Reference Graph** を実行し、`Storefront.CustomerSession` を選びます。保持グラフは、1 つの `Dictionary<int, CustomerSession>` のエントリ配列にぶら下がるすべての `CustomerSession` を描きます。コードの中でこの型を持つフィールドは 1 つだけ、静的フィールド `SessionCache.Sessions` です。断ち切るべき参照はこれです。

## ステップ 5：直す

キャッシュに必要なのは最近の注文だけなので、直近 1,000 件だけを残し、残りは削除します。

```csharp
// Remembers the last 1,000 orders "for analytics", and forgets older ones.
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order)
    {
        Sessions[order.Id] = new CustomerSession(order);
        Sessions.Remove(order.Id - 1_000);
    }
}
```

実際のコードでは、サイズ制限や有効期限付きの `MemoryCache` でも同じことができます。

## ステップ 6：確かめる

再ビルドして実行し、もう一度メモリを追跡します。録画では、リークしているビルドは疑いが High に達する前に 160 MB を超えました。修正後のビルドは約 8 MB で安定し、タイムラインは横ばいで、Low より上に上がる疑いはありません。測っていない修正は推測にすぎません。この修正は測定済みです。

## 同じ手順で見つかる 4 つの C# のメモリリーク

手順は変わりません。変わるのは保持グラフの終点にあるルートだけです。

### 外されないイベントハンドラー

```csharp
public sealed class PriceTicker(MarketFeed feed) : IDisposable
{
    public void Start() => feed.PriceChanged += OnPriceChanged;

    public void Dispose() => feed.PriceChanged -= OnPriceChanged;

    private void OnPriceChanged(object? sender, decimal price) { }
}
```

長寿命の `MarketFeed` は、そのイベントを通じてすべての購読者を保持します。`-=` がなければ、各 `PriceTicker` は feed と同じだけ生き続けます。保持グラフの終点は feed のイベントフィールドです。

### scoped のサービスを捕捉したシングルトン

依存性の注入では、シングルトンはアプリの全期間にわたって生き続けます。そのコンストラクターが `DbContext` のような scoped のサービスを受け取ると、そのインスタンスは追跡しているものすべてとともに、アプリの終了まで捕捉されます。グラフの終点はそのシングルトンです。代わりに `IServiceScopeFactory` を注入し、作業単位ごとにスコープを作ってください。

### 所有者より長生きするタイマー

`System.Threading.Timer` が動いている間、ランタイムのタイマーキューはそのコールバックを保持し、コールバックはそのターゲットを保持します。自分自身にコールバックするタイマーを持つコンポーネントは、自分のタイマーによって生かし続けられます。タイマーは所有者と一緒に破棄してください。

### F# のクロージャ

```fsharp
let handlers = ResizeArray<unit -> unit>()

let watch (session: CustomerSession) =
    handlers.Add(fun () -> printfn "%d" session.SnapshotBytes)
```

ラムダが `session` を捕捉し、モジュールレベルのリストがすべてのラムダを保持します。グラフの終点は `handlers` です。用が済んだらデリゲートを外すか、必要な値だけを捕捉してください。

## Dispose でメモリリークは直りますか？

それだけでは直りません。`Dispose` と `using` ステートメントはアンマネージドリソースを決まったタイミングで解放しますが、何かがまだ参照しているオブジェクトを回収可能にはしません。静的なリストに保持された破棄済みのオブジェクトは、やはりリークです。`Dispose` がリークを直すのは、上の `PriceTicker` のように、そこでイベントの購読を解除したり、タイマーを止めたり、キャッシュを空にしたりする場合です。

## 試してみる

SharpLsp は [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) から、または Cursor・Windsurf・VSCodium では [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) からインストールできます。[メモリリークの修正](/ja/docs/memory-leaks/)ガイドはこの手順のリファレンス版で、[プロファイラーのドキュメント](/ja/docs/profiler/)にすべてのコマンドと設定があります。
