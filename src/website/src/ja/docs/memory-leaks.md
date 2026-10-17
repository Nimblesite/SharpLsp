---
layout: layouts/docs.njk
title: C# と .NET のメモリリークを修正する
description: "C# と .NET のメモリリークを見つけて修正する方法：メモリリークとは何か、VS Code の無料の .NET メモリプロファイラーによるメモリリーク検出、そして静的キャッシュ、イベントハンドラー、Dispose、依存性の注入のライフタイムが原因のリークの直し方。"
lang: ja
eleventyExcludeFromCollections: true
---

# C# と .NET のメモリリークを修正する

このガイドでは、VS Code の SharpLsp メモリプロファイラーを使って、C# や F# のアプリのメモリリークを見つけて修正する方法を説明します。プロセスを追跡し、リークの疑いを読み、オブジェクトを生かし続けている参照を見つけ、修正し、その修正を確認します。実行中の .NET 8 以降のプロセスであれば、再起動もメモリダンプもライセンスも不要です。

{% video "profiler-fix-memory-leak" %}

## .NET のメモリリークとは？

.NET にはガベージコレクションがあり、ランタイムはもう何からも参照されていないオブジェクトをすべて解放します。つまり .NET のメモリリークとは、解放し忘れたメモリではありません。何かがまだ保持しているために、ガベージコレクターが決して解放できないオブジェクトです。一定の負荷のもとでプロセスのメモリが上がり続けて下がらず、やがてアプリが極端に遅くなるか、メモリが尽きます。

このガイドでは SharpLsp の Storefront デモアプリを使います。その `SessionCache` はすべての注文を静的な `Dictionary` に入れ、決して削除しません。

```csharp
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order) => Sessions[order.Id] = new CustomerSession(order);
}
```

## 始める前に

- SharpLsp をインストールし、プロジェクトを含むフォルダーを開きます。
- .NET 8 以降のランタイムでアプリを実行します。`DOTNET_EnableDiagnostics=0` で起動したプロセスにはアタッチできません。
- アプリに一定の負荷をかけます。疑わしいリクエスト、ページ、ジョブを繰り返してください。リークは、リークしているコードが動いている間にしか現れません。

## 1. メモリが上がり続けることを確かめる

SharpLsp ビューを開き、**Processes** でアプリを見つけます。各行にはプロセスのリアルタイムの CPU とメモリが表示されます。一定の負荷のもとで 1 分ほどメモリを観察してください。上がったり下がったりするメモリは、ガベージコレクションが働いている証拠です。上がる一方のメモリは、リークの候補です。

## 2. メモリを追跡する

行にカーソルを合わせて **Track Memory** をクリックするか、**SharpLsp: Start Memory Tracking** を実行します。コードの横に **SharpLsp Memory Dashboard** が開き、現在とピークのメモリ、生存オブジェクト数、ヒープのタイムラインを表示します。

定期的なヒープスナップショットを有効にすると、ダッシュボードがメモリリーク検出を代わりに行います。

```json
{
  "sharplsp.profiler.autoSnapshot": true,
  "sharplsp.profiler.autoSnapshotInterval": 10
}
```

**SharpLsp: Take Memory Snapshot** で自分でスナップショットを撮り、**SharpLsp: Compare Memory Snapshots** で比較することもできます。スナップショットの前に **SharpLsp: Force Garbage Collection** を実行すると、まだ回収されていないだけのゴミを除外できます。

## 3. リークの疑いを読む

各スナップショットは直前のものと比較されます。メモリが増えた型はリークの疑いになり、連続して増えるたびに確信度が上がります。

| 根拠 | 確信度 |
|---|---|
| 1 回の増加 | Low |
| 2 回連続の増加、または 10 MiB を超える 1 回の増加 | Medium |
| 3 回連続の増加 | High |

その型が増えなかったスナップショットで連続回数はリセットされるため、通常の割り当ての揺らぎが High に達することはまずありません。各疑いには、バイト数とオブジェクト数での増加量が表示されます。疑いをクリックすると、その割り当て箇所が開きます。エディターでは、リークしている型の宣言に紫のヒートバーとリークマーカーが付きます。最初の疑いが High に達すると、SharpLsp は通知で **Show Reference Graph** を提案します。

## 4. 何が生かし続けているかを見つける

**SharpLsp: Show Reference Graph** を実行し、疑いの型を選びます。一覧には、ランタイムが最新のスナップショットで報告した型が並びます。**Other type…** を選ぶと、`Storefront.CustomerSession` のように、ランタイムの表記どおりに型名を入力できます。

保持グラフは、その型を保持しているオブジェクトと、それらを生かし続けているルートを描きます。ルートから下へ読み、そのルートを保持しているフィールドをコードの中で探してください。Storefront では、すべての `CustomerSession` が 1 つの `Dictionary<int, CustomerSession>` のエントリ配列にぶら下がっていて、この型のフィールドは静的フィールド `SessionCache.Sessions` だけです。

ヒープの増加はシグナルであって、証拠ではありません。疑いは、保持パスと、コードが本来何をすべきかと照らし合わせて確かめてください。すべてを保持するためのキャッシュは、リークではありません。

## 5. メモリリークを修正する

保持パスが、断ち切るべき参照を示します。C# のメモリリークのよくある原因は次のとおりです。

| パスの終点 | 修正方法 |
|---|---|
| 静的なコレクションやキャッシュ | 上限を設ける：古いエントリを削除する、サイズを制限する、または有効期限付きの `MemoryCache` を使う |
| 長寿命オブジェクトのイベント | 購読者が不要になったら `-=` で購読を解除する（例：その `Dispose` の中で） |
| シングルトンのサービス | 依存性の注入のライフタイムを確認する：scoped や transient のサービスを捕捉したシングルトンは、それをアプリの終了まで生かし続ける |
| タイマーや実行中のタスク | 所有者がいなくなるときにタイマーを破棄し、タスクをキャンセルする |
| 長寿命オブジェクトに保存したラムダ | クロージャがオブジェクトを捕捉している：捕捉を減らすか、用が済んだらデリゲートを外す |

Storefront の修正では、直近 1,000 件の注文だけを残し、残りは削除します。

```csharp
public static void Remember(Order order)
{
    Sessions[order.Id] = new CustomerSession(order);
    Sessions.Remove(order.Id - 1_000);
}
```

F# での同じリークはモジュールレベルの `Dictionary` で、修正も同じです。

```fsharp
let private sessions = Dictionary<int, CustomerSession>()

let remember (order: Order) =
    sessions[order.Id] <- CustomerSession order
    sessions.Remove(order.Id - 1_000) |> ignore
```

## 6. 修正を確かめる

再ビルドし、同じ負荷でアプリを実行して、もう一度メモリを追跡します。キャッシュが埋まればヒープのタイムラインは横ばいになり、High まで上がる疑いもないはずです。それでも High に達するものがあれば、その保持グラフをもう一度表示してください。2 つ目のルートが保持しています。

## よくある質問

### Dispose でメモリリークは直りますか？

リークしているのが `Dispose` の解放対象そのものである場合だけです。`Dispose` と `using` ステートメントは、ハンドル、ソケット、ネイティブメモリなどのアンマネージドリソースを決まったタイミングで解放します。何かがまだ参照しているオブジェクトを回収可能にはしません。静的なリストに保持された破棄済みのオブジェクトは、やはりリークです。`Dispose` が役立つのは、そこでイベントの購読を解除したりタイマーを止めたりする場合です。

### ヒープダンプやメモリダンプは必要ですか？

いいえ。`dotnet-dump` や `dotnet-gcdump` はファイルを書き出し、それを Visual Studio や PerfView などの別のツールで開く必要があります。SharpLsp はランタイムの診断チャネルを通じて実行中のプロセスからヒープスナップショットを読むので、メモリプロファイラーは Windows・macOS・Linux のエディター内で動作します。証拠を残す必要があるときや、アタッチできないマシンでプロセスが動いているときにダンプを使ってください。

### これは Visual Studio のメモリプロファイラーですか？

いいえ。SharpLsp 独自のメモリプロファイラーで、オープンソースかつ MIT ライセンスです。スナップショット、比較、保持パスという同じ流れを、VS Code・Cursor・Windsurf・VSCodium の中で提供します。

## 関連ドキュメント

- [プロファイラー](/ja/docs/profiler/)：プロファイラーのすべてのコマンドと設定
- [設定](/ja/docs/configuration/)：`sharplsp.toml` の `[profiler]` テーブル
- [C# と .NET のメモリリークを修正する方法：ステップバイステップ](/ja/blog/how-to-fix-a-memory-leak-in-csharp-dotnet/)：1 つのリークを、最初の疑いから測定済みの修正まで
