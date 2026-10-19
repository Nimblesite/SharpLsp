---
layout: layouts/docs.njk
title: C# と .NET のメモリリークを修正する方法
description: "C# と .NET のメモリリークを修正する方法をステップバイステップで解説：VS Code の無料の .NET メモリプロファイラーによるメモリリーク検出、原因を示す保持パス、静的キャッシュ・イベントハンドラー・Dispose・タイマー・依存性の注入が原因のリークの直し方、そして dotnet-counters・dotnet-gcdump・dotnet-dump を使う方法。"
lang: ja
---

# C# と .NET のメモリリークを修正する方法

このガイドでは、実際の C# のメモリリークを、最初の疑いから測定済みの修正までたどります。メモリが上がり続けることを確かめ、VS Code の無料の SharpLsp メモリプロファイラーでプロセスを追跡し、リークの疑いを読み、オブジェクトを生かし続けている参照を見つけて修正し、テストで修正を証明します。.NET 8 以降で動く C# や F# のアプリであれば、再起動もメモリダンプもライセンスも不要です。コマンドラインや Visual Studio に同等の手段がある手順では、それも紹介します。

SharpLsp の Storefront デモで、一連の流れを VS Code で録画しました。早送りした部分は画面に表示されます。

{% video "profiler-fix-memory-leak" %}

## C# と .NET のメモリリークとは？

.NET には[ガベージコレクション](https://learn.microsoft.com/ja-jp/dotnet/standard/garbage-collection/fundamentals)があり、ランタイムはもう何からも参照されていないオブジェクトをすべて解放します。つまり C# のメモリリークとは、解放し忘れたメモリではありません。アプリにはもう不要なのに、静的なコレクション、イベント、長寿命のサービス、タイマーなどがまだ参照しているオブジェクトです。Microsoft の[メモリリークのチュートリアル](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/debug-memory-leak)が説明するとおり、その参照があるとガベージコレクターは使用中のメモリを回収できません。一定の負荷のもとでは、リークしているコードが動いている限り、プロセスのメモリが上がり続けます。

Storefront にはまさにこのバグがあります。その `SessionCache` はすべての注文を「分析用に」静的な `Dictionary` に記録し、決して削除しません。

```csharp
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order) => Sessions[order.Id] = new CustomerSession(order);
}
```

各 `CustomerSession` は 4 KB のバッファーを持ち、どれも解放されることがありません。

## メモリリークの兆候

- 一定の負荷のもとでメモリが上がり続け、下がらない。
- 何時間、何日と経つうちにアプリが遅くなり、再起動するとしばらく直る。
- ガベージコレクションの頻度が上がり、回収できる量が毎回減っていく。
- アプリが `OutOfMemoryException` をスローする、またはコンテナーがメモリ上限を超えて強制終了される。

### メモリリークか、単にメモリ使用量が多いだけか？

上昇がすべてリークとは限りません。[サーバーガベージコレクション](https://learn.microsoft.com/ja-jp/dotnet/standard/garbage-collection/workstation-server-gc)は、設計上ワークステーションガベージコレクションより大きなヒープを保持します。すべてを保持するためのキャッシュは、埋まったあと横ばいになります。また、ガベージコレクターは解放したメモリをすぐにはオペレーティングシステムに返しません。

見分けるには、完全なブロッキングコレクションである **SharpLsp: Force Garbage Collection** を実行します。メモリが下がれば、まだ回収されていなかっただけのゴミです。同じ負荷で下がらずに上がり続けるなら、何かが保持しています。

### マネージドかネイティブか？

**Processes** ビューには、各プロセスの常駐メモリ、つまりオペレーティングシステムがプロセスに与えたすべてのメモリが表示されます。メモリダッシュボードには、ガベージコレクターが追跡するオブジェクトであるマネージドヒープが表示されます。常駐メモリが上がるのにヒープが横ばいなら、リークはネイティブメモリにあります。たとえばネイティブライブラリ、解放されない `Marshal.AllocHGlobal` のバッファー、所有者が破棄されない[アンマネージドリソース](https://learn.microsoft.com/ja-jp/dotnet/standard/garbage-collection/unmanaged)などです。ヒープスナップショットにネイティブメモリは映りません。Windows では、Visual Studio の[メモリ使用量ツール](https://learn.microsoft.com/ja-jp/visualstudio/profiling/memory-usage)でネイティブヒープのスナップショットを撮れます。このガイドの以降の部分では、マネージドのリークを見つけて修正します。

## 始める前に

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) から、または Cursor・Windsurf・VSCodium では [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) から SharpLsp をインストールし、プロジェクトを含むフォルダーを開きます。
- .NET 8 以降のランタイムでアプリを実行します。[`DOTNET_EnableDiagnostics=0`](https://learn.microsoft.com/ja-jp/dotnet/core/runtime-config/debugging-profiling) で起動したプロセスにはアタッチできません。
- アプリに一定の負荷をかけます。疑わしいリクエスト、ページ、ジョブを繰り返してください。リークは、リークしているコードが動いている間にしか現れません。

## ステップ 1：メモリが上がり続けることを確かめる

SharpLsp ビューを開き、**Processes** でアプリを見つけます。各行にはプロセスのリアルタイムの CPU とメモリが表示されます。一定の負荷のもとで 1 分ほどメモリを観察してください。上がったり下がったりするメモリは、ガベージコレクションが働いている証拠です。上がる一方のメモリは、リークの候補です。Storefront のメモリは上がる一方です。

ターミナルでは、[dotnet-counters](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/dotnet-counters) で同じ上昇を確認できます。`dotnet-counters monitor --refresh-interval 1 -p <pid>` を実行し、GC ヒープサイズ（.NET 9 以降では `dotnet.gc.last_collection.heap.size`）を観察します。

## ステップ 2：メモリを追跡する

行にカーソルを合わせて **Track Memory** をクリックするか、**SharpLsp: Start Memory Tracking** を実行します。コードの横に **SharpLsp Memory Dashboard** が開き、現在とピークのメモリ、生存オブジェクト数、ヒープのタイムラインを表示します。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-memory.webp" alt="着実に上昇するヒープタイムラインに STEADY GROWTH possible leak と表示されたメモリダッシュボードと、隣の SessionCache.cs" width="2400" height="1500">
  <figcaption>スナップショットのたびにタイムラインが上昇し、着実な増加がグラフ上で指摘されます。</figcaption>
</figure>

定期的なヒープスナップショットを有効にすると、ダッシュボードがメモリリーク検出を代わりに行います。

```json
{
  "sharplsp.profiler.autoSnapshot": true,
  "sharplsp.profiler.autoSnapshotInterval": 10
}
```

**SharpLsp: Take Memory Snapshot** で自分でスナップショットを撮り、**SharpLsp: Compare Memory Snapshots** で比較することもできます。各スナップショットは完全なガベージコレクションから始まるため、それを生き残ったオブジェクトだけが数えられます。

## ステップ 3：リークの疑いを読む

各スナップショットは直前のものと比較されます。メモリが増えた型はリークの疑いになり、連続して増えるたびに確信度が上がります。

| 根拠 | 確信度 |
|---|---|
| 1 回の増加 | Low |
| 2 回連続の増加、または 10 MiB を超える 1 回の増加 | Medium |
| 3 回連続の増加 | High |

その型が増えなかったスナップショットで連続回数はリセットされるため、通常の割り当ての揺らぎが High に達することはまずありません。各疑いには、バイト数とオブジェクト数での増加量が表示されます。疑いをクリックすると、その割り当て箇所が開きます。エディターでは、リークしている型の宣言に紫のヒートバーとリークマーカーが付きます。最初の疑いが High に達すると、SharpLsp は通知で **Show Reference Graph** を提案します。

数回のスナップショットで、Storefront の `CustomerSession` が High になります。それが保持するバイト配列、注文、商品リストも同様です。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-leaks.webp" alt="MB 単位の増加量とオブジェクト数とともに HIGH とランク付けされたリークの疑いと、SessionCache.cs の CustomerSession 宣言に表示されたインラインの HIGH リークマーカー" width="2400" height="1500">
  <figcaption>リークの疑い。エントリを削除しない静的な <code>Dictionary</code> が、バイト配列、文字列、それらを保持するセッションの一貫した増加として現れています。</figcaption>
</figure>

## ステップ 4：何が生かし続けているかを見つける

増加からわかるのは、*何が*リークしているかです。修正には*なぜ*が必要です。**SharpLsp: Show Reference Graph** を実行し、疑いの型を選びます。一覧には、ランタイムが最新のスナップショットで報告した型が並びます。**Other type…** を選ぶと、`Storefront.CustomerSession` のように、ランタイムの表記どおりに型名を入力できます。

保持グラフは、その型を保持しているオブジェクトと、それらを生かし続けているルートを描きます。ルートから下へ読み、そのルートを保持しているフィールドをコードの中で探してください。Storefront では、すべての `CustomerSession` が 1 つの `Dictionary<int, CustomerSession>` のエントリ配列にぶら下がっていて、この型のフィールドは静的フィールド `SessionCache.Sessions` だけです。これが断ち切るべき参照です。

これは、メモリダンプでは `gcroot` が、Visual Studio では **Paths to Root** が答える問いです。ヒープの増加はシグナルであって、証拠ではありません。疑いは、保持パスと、コードが本来何をすべきかと照らし合わせて確かめてください。すべてを保持するためのキャッシュは、リークではありません。

## ステップ 5：メモリリークを修正する

Storefront のキャッシュに必要なのは最近の注文だけなので、直近 1,000 件だけを残して残りを削除します。

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

F# での同じリークはモジュールレベルの `Dictionary` で、修正も同じです。[F# のプロファイリング](/ja/docs/fsharp-profiling/)では、Storefront の F# 版である FsStorefront でこの流れを収録しています。

```fsharp
let private sessions = Dictionary<int, CustomerSession>()

let remember order =
    let stage = CheckedOut order.Total
    sessions[order.Id] <- { Order = order; Stage = stage; Snapshot = Array.zeroCreate 4096 }
    sessions.Remove(order.Id - 1_000) |> ignore
```

実際のコードでは、サイズ制限や有効期限付きの `MemoryCache` で同じことができます。保持パスの終点が別の場所なら、下の「*C# のよくあるメモリリーク*」で修正方法を探してください。

## ステップ 6：修正を証明する

再ビルドし、同じ負荷でアプリを実行して、もう一度メモリを追跡します。キャッシュが埋まればヒープのタイムラインは横ばいになり、High まで上がる疑いもないはずです。それでも High に達するものがあれば、その保持グラフをもう一度表示してください。2 つ目のルートが保持しています。

録画では、リークしているビルドは疑いが High に達する前に 160 MB を超えました。修正後のビルドは約 8 MB で安定し、タイムラインは横ばいで、Low を超える疑いはありません。測定していない修正は推測にすぎません。この修正は測定済みです。修正を保つには、下で紹介するリークのテストを追加します。

## C# のよくあるメモリリークとその直し方

手順はリークが変わっても同じです。変わるのは、保持パスの終点にあるルートだけです。

| パスの終点 | 修正方法 |
|---|---|
| 静的なコレクションやキャッシュ | 上限を設ける：古いエントリを削除する、サイズを制限する、または有効期限付きの `MemoryCache` を使う |
| 長寿命オブジェクトのイベント | 購読者が不要になったら `-=` で購読を解除する（例：その `Dispose` の中で） |
| シングルトンのサービス | 依存性の注入のライフタイムを確認する：scoped サービスを捕捉したシングルトンは、それをアプリの終了まで保持する |
| タイマー | 所有者がいなくなるときにタイマーを破棄する |
| キャンセルトークン | 処理が終わったら `CancellationTokenRegistration` を破棄する |
| 長寿命オブジェクトに保存したラムダ | クロージャがオブジェクトを捕捉している：捕捉を減らすか、用が済んだらデリゲートを外す |

### エントリを削除しない静的なコレクションやキャッシュ

Storefront のリークはこれです。静的フィールドはアプリと同じだけ生き続け、その中身もすべて同様です。F# のモジュールレベルの値も同じです。コレクションに上限を設けるか、有効期限や `SizeLimit` を設定した [`MemoryCache`](https://learn.microsoft.com/ja-jp/dotnet/core/extensions/caching) を使ってください。`SizeLimit` を設定した場合は、すべてのエントリに `Size` を設定する必要があります。

### 解除されないイベントハンドラー

```csharp
public sealed class PriceTicker(MarketFeed feed) : IDisposable
{
    public void Start() => feed.PriceChanged += OnPriceChanged;

    public void Dispose() => feed.PriceChanged -= OnPriceChanged;

    private void OnPriceChanged(object? sender, decimal price) { }
}
```

長寿命の `MarketFeed` は、イベントを通じてすべての購読者を保持します。`-=` がなければ、各 `PriceTicker` はフィードと同じだけ生き続けます。保持パスはフィードのイベントフィールドで終わります。

F# では、`Add` による購読は解除できません。`Subscribe` はハンドラーを外す `IDisposable` を返すので、それを保持し、購読者と一緒に破棄してください。

```fsharp
type PriceTicker(feed: MarketFeed) =
    let mutable last = 0M
    let subscription = feed.PriceChanged.Subscribe(fun price -> last <- price)

    member _.Last = last

    interface IDisposable with
        member _.Dispose() = subscription.Dispose()
```

コントロールが購読解除のタイミングを判断できないことがある WPF では、[弱いイベントパターン](https://learn.microsoft.com/ja-jp/dotnet/desktop/wpf/events/weak-event-patterns)を使います。

### scoped サービスを捕捉するシングルトン

依存性の注入では、シングルトンはアプリの終了まで生き続けます。シングルトンが `DbContext` のような scoped サービスを受け取ると、そのインスタンスは、追跡しているすべてのエンティティとともにアプリの終了まで捕捉されます。

```csharp
builder.Services.AddDbContext<ShopContext>();
builder.Services.AddSingleton<PriceCache>();

// Leaks: one ShopContext, and everything it tracks, lives as long as the app.
public sealed class PriceCache(ShopContext db) { }
```

Microsoft の[依存性の注入のガイドライン](https://learn.microsoft.com/ja-jp/dotnet/core/extensions/dependency-injection/guidelines)では、これをキャプティブ依存関係と呼んでいます。スコープの検証を有効にすると、コンテナーはシングルトンを解決するときにこれを拒否します。ASP.NET Core では、Development 環境でスコープの検証が有効になります。修正方法は、`IServiceScopeFactory` を受け取り、作業単位ごとにスコープを作ることです。

```csharp
public sealed class PriceCache(IServiceScopeFactory scopes)
{
    public async Task<decimal> PriceOfAsync(int productId)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ShopContext>();
        return await db.Products.Where(p => p.Id == productId).Select(p => p.Price).SingleAsync();
    }
}
```

同じガイドラインは、破棄可能な transient サービスについても警告しています。コンテナーはそれぞれをスコープの終わりまで保持するため、ルートプロバイダーから解決したものはアプリが停止するまで残ります。

### 所有者より長生きするタイマー

```csharp
public sealed class StockPoller : IDisposable
{
    private readonly Timer timer;

    public StockPoller() => timer = new Timer(_ => Poll(), null, TimeSpan.Zero, TimeSpan.FromSeconds(5));

    public void Dispose() => timer.Dispose();

    private void Poll() { }
}
```

このポーリングクラスは、[`Timer` のドキュメント](https://learn.microsoft.com/ja-jp/dotnet/api/system.threading.timer)が求めるとおりタイマーをフィールドに保持し、タイマーのコールバックはポーリングクラス自身を指しています。タイマーが動いている間はランタイムのタイマーキューがそのコールバックを保持するため、ポーリングクラスは決して回収されません。タイマーは所有者と一緒に破棄してください。

### 長寿命のトークンに登録したコールバック

```csharp
// Each call adds a callback to the app's stopping token, and only shutdown removes it.
lifetime.ApplicationStopping.Register(() => session.Close());

// Fixed: the registration is removed when the work ends.
using var registration = lifetime.ApplicationStopping.Register(() => session.Close());
```

[`CancellationToken.Register`](https://learn.microsoft.com/ja-jp/dotnet/api/system.threading.cancellationtoken.register) は `CancellationTokenRegistration` を返します。それを破棄するかトークンがキャンセルされるまで、トークンのソースはコールバックと、それが捕捉したすべてを保持します。

### F# のクロージャ

```fsharp
let handlers = ResizeArray<unit -> unit>()

let watch (session: CustomerSession) =
    handlers.Add(fun () -> printfn "%d" session.SnapshotBytes)
```

ラムダは `session` を捕捉し、モジュールレベルのリストはすべてのラムダを保持します。保持パスは `handlers` で終わります。用が済んだらデリゲートを外すか、必要な値だけを捕捉してください。

## リークの修正をテストで守る

リークのテストは、テスト対象のコードが手放すべき参照をすべて手放させ、コレクションを実行し、オブジェクトが消えたことを確認します。オブジェクトはインライン化されない別のメソッドで作成し、テスト内のローカル変数がオブジェクトを生かし続けないようにします。`GC.KeepAlive(feed)` は長寿命の発行元を最後まで生かし続けるので、ティッカーが購読したままならテストは失敗します。

```csharp
[Fact]
public void ADisposedTickerCanBeCollected()
{
    var feed = new MarketFeed();
    var ticker = StartAndDispose(feed);

    GC.Collect();
    GC.WaitForPendingFinalizers();
    GC.Collect();

    Assert.False(ticker.IsAlive);
    GC.KeepAlive(feed);
}

[MethodImpl(MethodImplOptions.NoInlining)]
private static WeakReference StartAndDispose(MarketFeed feed)
{
    using var ticker = new PriceTicker(feed);
    ticker.Start();
    return new WeakReference(ticker);
}
```

F# で書いた同じテストです。

```fsharp
[<MethodImpl(MethodImplOptions.NoInlining)>]
let startAndDispose (feed: MarketFeed) =
    use ticker = new PriceTicker(feed)
    WeakReference ticker

[<Fact>]
let ``a disposed ticker can be collected`` () =
    let feed = MarketFeed()
    let ticker = startAndDispose feed
    GC.Collect()
    GC.WaitForPendingFinalizers()
    GC.Collect()
    Assert.False ticker.IsAlive
    GC.KeepAlive feed
```

`Dispose` から購読解除を取り除くと、テストは失敗します。フィードのイベントがまだティッカーを保持しているからです。[`WeakReference`](https://learn.microsoft.com/ja-jp/dotnet/api/system.weakreference) は、オブジェクトを生かし続けずに見張ります。

## コマンドラインでのメモリリーク検出

サーバーやコンテナーでは、.NET の診断ツールを使えば、エディターなしで同じリークを見つけられます。手順は Microsoft の[メモリリークのデバッグ](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/debug-memory-leak)チュートリアルで説明されています。

`dotnet-counters` で上昇を確かめます。

```console
dotnet tool install --global dotnet-counters
dotnet-counters ps
dotnet-counters monitor --refresh-interval 1 -p <pid>
```

[dotnet-gcdump](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/dotnet-gcdump) でヒープのスナップショットを撮ります。`report` はヒープの型をサイズ順に一覧表示します。数分おいて 2 つの GC ダンプを収集し、Windows の Visual Studio または [PerfView](https://github.com/microsoft/perfview) で比較してください。収集すると完全なガベージコレクションが実行されるため、ヒープが大きいアプリは長時間停止することがあります。

```console
dotnet-gcdump collect -p <pid>
dotnet-gcdump report <file>.gcdump
```

[dotnet-dump](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/dotnet-dump) とその [SOS コマンド](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/sos-debugging-extension)でルートを見つけます。`dumpheap -stat` は型を数とサイズで一覧表示し、`dumpheap -mt` は 1 つの型のインスタンスを一覧表示し、`gcroot` はルートから 1 つのインスタンスまでの参照の連鎖を出力します。ダンプにはプロセスのメモリ全体が、そこにある機密情報も含めて入っているので、本番データと同じように扱ってください。

```console
dotnet-dump collect -p <pid>
dotnet-dump analyze <dump-file>
> dumpheap -stat
> dumpheap -mt <method-table>
> gcroot <object-address>
```

本番環境では、[dotnet-monitor](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/dotnet-monitor) が同じダンプと GC ダンプを HTTP API で収集します。

| ツール | 動作する場所 | 用途 |
|---|---|---|
| SharpLsp メモリプロファイラー | Windows・macOS・Linux の VS Code、Cursor、Windsurf、VSCodium | リークの疑いをリアルタイムにランク付けし、コードの横に保持パスを描く |
| `dotnet-counters` | 任意のターミナル | ヒープが上がり続けることを確かめる |
| `dotnet-gcdump` | 任意のターミナル（ファイルは Windows で開く） | 実行中のヒープのスナップショットを撮り、比較する |
| `dotnet-dump` | 任意のターミナル | 完全なダンプを残し、`gcroot` でルートを見つける |
| `dotnet-monitor` | サーバーとコンテナー | 本番環境でダンプを収集する |
| Visual Studio のメモリ使用量ツール | Windows | デバッグ中にスナップショットを撮り、比較し、Paths to Root をたどる |
| PerfView | Windows | ヒープとガベージコレクションを詳しく分析する |

## よくある質問

### Dispose でメモリリークは直りますか？

それだけでは直りません。`Dispose` と `using` ステートメントは、ハンドル、ソケット、ネイティブメモリなどのアンマネージドリソースを決まったタイミングで解放します。何かがまだ参照しているオブジェクトを回収可能にはしません。静的なリストに保持された破棄済みのオブジェクトは、やはりリークです。`Dispose` でリークが直るのは、上の `PriceTicker` のように、そこでイベントの購読を解除したり、タイマーを止めたり、キャッシュを空にしたりする場合です。このパターンは Microsoft の [Dispose メソッドの実装](https://learn.microsoft.com/ja-jp/dotnet/standard/garbage-collection/implementing-dispose)で説明されています。

### GC.Collect でメモリリークは直りますか？

いいえ。コレクションで解放されるのは何からも参照されていないオブジェクトだけで、リークしたオブジェクトは参照されています。強制的なコレクションは、診断やテストで、まだ回収されていないだけのゴミを除外するのに役立ちます。リークを直すことはありません。

### ヒープダンプやメモリダンプは必要ですか？

いいえ。`dotnet-dump` や `dotnet-gcdump` はファイルを書き出し、それを Visual Studio や PerfView などの別のツールで開く必要があります。SharpLsp はランタイムの[診断チャネル](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/eventpipe)を通じて実行中のプロセスからヒープスナップショットを読むので、メモリプロファイラーは Windows・macOS・Linux のエディター内で動作します。証拠を残す必要があるときや、アタッチできないマシンでプロセスが動いているときにダンプを使ってください。

### これは Visual Studio のメモリプロファイラーですか？

いいえ。SharpLsp 独自のメモリプロファイラーで、オープンソースかつ MIT ライセンスです。Visual Studio のメモリ使用量ツールは、Windows で同じ流れを提供します。スナップショット、比較、Paths to Root に加え、イベントハンドラーのリークを指摘する分析情報もあります。SharpLsp はその流れを、あらゆるプラットフォームの VS Code・Cursor・Windsurf・VSCodium にもたらします。

## 参考資料

- [メモリリークのデバッグ](https://learn.microsoft.com/ja-jp/dotnet/core/diagnostics/debug-memory-leak)：`dotnet-counters` と `dotnet-dump` を使う Microsoft のチュートリアル
- [ガベージコレクションの基礎](https://learn.microsoft.com/ja-jp/dotnet/standard/garbage-collection/fundamentals)：.NET のガベージコレクターが、何がまだ生きているかを判断する仕組み
- [mem-doc](https://github.com/Maoni0/mem-doc)：.NET GC のアーキテクトである Maoni Stephens による .NET メモリ分析ガイド。Maoni Stephens は [.NET Blog](https://devblogs.microsoft.com/dotnet/author/maoni/) でも GC について執筆しています
- [Pro .NET Memory Management](https://prodotnetmemory.com/)：Konrad Kokosa、Kevin Gosse、Christophe Nasarre による、.NET メモリの内部構造を解説した本
- [依存性の注入のガイドライン](https://learn.microsoft.com/ja-jp/dotnet/core/extensions/dependency-injection/guidelines)：キャプティブ依存関係と破棄可能な transient サービス
- [アプリのメモリ使用量を測定する](https://learn.microsoft.com/ja-jp/visualstudio/profiling/memory-usage)：Visual Studio のメモリ使用量ツール
- [8 Ways You can Cause Memory Leaks in .NET](https://michaelscodingspot.com/ways-to-cause-memory-leaks-in-dotnet/)：Michael Shpilt による、よくある原因のまとめ

## 関連ドキュメント

- [プロファイラー](/ja/docs/profiler/)：プロファイラーのすべてのコマンドと設定
- [F# のプロファイリング](/ja/docs/fsharp-profiling/)：F# アプリでの同じ流れ
- [設定](/ja/docs/configuration/)：`sharplsp.toml` の `[profiler]` テーブル
