---
layout: layouts/blog.njk
title: "SharpLsp のご紹介：Rust で構築された .NET LSP"
description: "SharpLsp は C# と F# のためのオープンソースのエディター非依存言語サーバーです。Rust で構築し、Roslyn と FSharp.Compiler.Service を活用しています。ライセンス不要、ロックインなし、すべてのエディターで動作します。"
lang: ja
date: 2026-03-20
author: Christian Findlay
image: /assets/images/blog/introducing-sharplsp.png
imageAlt: Rust ホストエンジンと C# / F# サイドカーモジュールを接続した構成図
tags:
  - posts
  - announcement
  - rust
  - csharp
  - fsharp
category: announcement
excerpt: "私たちは Microsoft が .NET ツールを直してくれるのを待つことを終わりにしました。SharpLsp はその答えです。Rust ホストの LSP サーバーが、すべてのエディターで第一級の C# と F# サポートを提供します。プロプライエタリな依存関係はゼロです。"
---

私たちは待つのをやめました。

Windows 以外での .NET 開発体験は壊れています。理論上の話ではなく、公の場で実証された事実です。Microsoft のクローズドソースなツール発表に対するコミュニティの [12 対 1 の拒絶反応](https://github.com/dotnet/vscode-csharp/issues/5276) と、Mac 開発者に対して仮想マシン内で Windows を動かすよう告げた廃止発表がその証左です。SharpLsp はコミュニティからの答えです。C# と F# のためのオープンソースかつエディター非依存の言語サーバーであり、Rust で構築され、[Roslyn](https://github.com/dotnet/roslyn) と [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) を活用しています。MIT ライセンス。プロプライエタリな依存関係はゼロ。1 度のインストールで、マシン上のあらゆるエディターに対応します。

## 状況は思っているより深刻です

今日の .NET 開発者が手にしている選択肢は、いずれも致命的な欠陥を抱えています。単なる癖ではなく、パッチでは消せない構造的な問題です。なぜここに至ったのかを理解することは、SharpLsp が存在しなければならなかった理由、そして中途半端な対策がなぜ何も解決できなかったのかを理解する上で重要です。

ここ十数年近くのあいだ、Visual Studio 以外を使う .NET 開発者は、断片化し、不平等で、ますますプロプライエタリ化が進むツール環境を渡り歩いてきました。OmniSharp はコミュニティの回避策でした。Ionide は F# コミュニティの回避策でした。Neovim や Helix 向けに増殖したコミュニティ管理の LSP 設定スニペットも、すべて回避策です。本物はひとつもありませんでした。Microsoft はこの問題のコストをコミュニティに肩代わりさせながら、解決策の主導権は手放さないという行動を繰り返してきました。

問題の核心は構造的です。Microsoft は C# 言語を支配しています。Microsoft は Roslyn コンパイラーを支配しています。Microsoft は支配的な VS Code 拡張機能の名前空間を支配しています。そして Microsoft の商業的なインセンティブは、開発者に世界水準でオープンかつ可搬性のあるツールを与えることとは一致していません。Visual Studio の商業的価値は、その一部がプラットフォームロックインに依存しています。C# Dev Kit の Microsoft にとっての価値は、VS Code エコシステムを成長させる能力にあるのであって、あらゆる場所で利用できることにあるわけではありません。

### Visual Studio: Windows 専用、それで終わり

Visual Studio は依然として Windows 専用です。2023 年 8 月、Microsoft は Visual Studio for Mac の廃止を発表し、2024 年 8 月 31 日に有効となりました。[公式の廃止発表](https://devblogs.microsoft.com/visualstudio/visual-studio-for-mac-retirement-announcement/) では、F# が必要な Mac 開発者向けの代替手段が次のように列挙されています。

> **「Mac 上の VM で Windows 版 Visual Studio IDE を実行する: この選択肢は、Xamarin、F#、iOS のリモート開発体験のレガシープロジェクトサポートを含め、最も広範な IDE のニーズをカバーします。仮想マシン (VM) を使用してください。」**

これは回避策ではありません。これは Microsoft が Mac の F# 開発者に対し、自分の選んだ言語でコードを書くために、自分のコンピューターの中で別のオペレーティングシステムを動かすよう告げているのです。Reddit の r/dotnet では、ユーザーの **AbsurdPreferred** が広範なコミュニティの反応を次のように要約しています。

> "This is not surprising to me at all. Visual Studio for Mac is horrible and it was clear that MS didn't care about it at all. I hated using it so much that I switched to Rider on Mac. Then loved that so much, I switched to Rider when I do dev work on PC."
>
> （まったく驚きはありません。Visual Studio for Mac はひどく、MS が気にかけていないのは明らかでした。使うのが嫌で Mac では Rider に乗り換えました。Rider があまりに気に入って、PC で開発する時も Rider に切り替えました。）

ユーザーの **leeharrison1984** は、多くの人が何年も思っていたことをこう付け加えました。

> "VS for Mac has been a joke for years and severely lacked features that existed in Windows VS for years. In the last few years, if ever I found myself on a Mac and needed to do some C# work, I'm opening VS Code."
>
> （VS for Mac は何年もジョークのような存在で、Windows 版 VS にあった機能を長年大幅に欠いていました。ここ数年、Mac で C# の作業が必要になったときは、私は VS Code を開いています。）

廃止は、注意を払っていた誰にとっても驚きではありませんでした。Visual Studio for Mac は常に二級の体験でした。Xamarin Studio をリブランドしたものに過ぎず、Windows 版に追いつくことはありませんでした。印象的だったのは、Windows VM を動かすという公式の明示的な助言です。これは、エコシステムが静かに受け入れていたことを裏付けました。macOS や Linux で本格的に .NET を使う開発者にとって、Microsoft には説得力のあるストーリーがないということです。

### C# Dev Kit: クローズドコア、エンタープライズの有料ライン、VS Code 専用

Microsoft が代替として提示したのは [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit) でした。2023 年に出荷され、敵対的な反応を受けました。[GitHub Issue #5276](https://github.com/dotnet/vscode-csharp/issues/5276)、つまり拡張機能の LSP ホストにクローズドソースコンポーネントが含まれることを Microsoft が明らかにしたロードマップ発表に対し、コミュニティは強く反発しました。

発表自体には、次の重要な一文が含まれていました。

> 「'LSP Tools Host' はオープンソース化されません。ただし、私たちはコミュニティと対話を続け、今後の計画を導く一助としていきます。」

GitHub ユーザーの **GerardSmit** は、根本的な矛盾を次のように述べました。

> "I feel like Microsoft has noticed the amount of installs the C# extension has and has to step (aka embrace) in. I feel like VSCode was always about (almost) open-source so this feels like a step in the bad direction. Currently the extension has 16M installs. Will all these installs automatically switch to the closed-source part of the extension?"
>
> （Microsoft は C# 拡張のインストール数に気付いて、踏み込む（embrace する）必要があると感じたのでしょう。VSCode は常に（ほぼ）オープンソースを志向してきたので、これは悪い方向への一歩に感じます。現在拡張機能は 1,600 万インストールあります。これらすべてのインストールが、自動的にクローズドソース部分の拡張機能に切り替わるのでしょうか？）

ユーザーの **mhmd-azeez** は明白な代替案を提案しました。

> "While 'C# in VS Code' getting some love is very much welcome, the new LSP implementation not being open source is a weird decision. I hope Microsoft reconsiders it. If it's about IntelliCode, then they can make the LSP server extensible and open source, with some optional closed source components. GitHub Copilot lives as a separate extension and works everywhere, maybe a similar method can be used for IntelliCode in VS Code too?"
>
> （「VS Code の C#」に光が当たるのは大歓迎ですが、新しい LSP 実装がオープンソースでないのは奇妙な判断です。Microsoft には再考してほしいです。もし IntelliCode のためというなら、LSP サーバーを拡張可能でオープンソースにし、オプションのクローズドソースコンポーネントを足すこともできます。GitHub Copilot は別拡張として存在しどこでも動きます。VS Code の IntelliCode にも同様のやり方を使えるのではないでしょうか？）

ユーザーの **jasiozet** はもっと率直でした。

> "It's sad and short-sighted when Microsoft tries to jockey for power in the short-run by making user-hostile decisions. This seems like another instance of embrace/extend/extinguish. It's predictable by now, but I'm not happy about it!"
>
> （Microsoft がユーザーに敵対的な判断で短期的な力を取りにいくのは、悲しく短絡的です。これは embrace / extend / extinguish のもうひとつの例に見えます。もう予測できる話ですが、納得は到底できません！）

クローズドソースの中核だけが問題ではありませんでした。[C# Dev Kit のライセンス](https://marketplace.visualstudio.com/items/ms-dotnettools.csdevkit/license) には厳しいエンタープライズ制限が含まれており、ユーザー数 250 名超または年間売上 100 万米ドル超の組織は、有料の Visual Studio サブスクリプションなしには拡張機能を使用できません。この閾値は、資金調達済みの多くのスタートアップ、中規模のエンジニアリングチーム、そして黒字経営の中小企業をカバーしてしまいます。発表時点で拡張機能のインストール数は 1,600 万に達していました。その圧倒的多数は、自分たちが商用ライセンス制限の対象であることを知りませんでした。

C# Dev Kit はさらに **VS Code 専用**です。Neovim、Helix、Emacs、Zed、その他いかなる LSP 対応エディターでも動作しません。ユーザーの **GerardSmit** が同じ Issue スレッドで指摘したとおりです。「Microsoft はこれらのエディター向けに拡張機能を作らないでしょう」。彼は正しかったのです。Microsoft はそれを認めました。デバッガーのライセンスは変更されず、VS Code 以外のエディターのサポート計画はありません。ターミナル中心のワークフローで生きているなら、あなたは単純に C# Dev Kit の対象オーディエンスではないということです。

### OmniSharp: コミュニティの孤児

OmniSharp は、長年にわたり初代 C# 拡張機能を支えたオープンソースの縁の下の力持ちでした。複数のエディターで動作し、MIT ライセンスで、コミュニティが維持していました。理論上は。実際には、Issue #5276 のスレッドである開発者が指摘したとおりです。

> "We'll see how much love the open-source LSP server will get but I don't have much hope. This year, JoeRobich and 50Wliu have made the most commits and are both working at Microsoft."
>
> （オープンソース LSP サーバーがどれほど手厚く扱われるかは見守るしかありませんが、私は大きな期待は持っていません。今年、最もコミットしているのは JoeRobich と 50Wliu で、二人とも Microsoft で働いています。）

OmniSharp の継続的な健全性は、Microsoft 社員がそれを優先するかどうかに依存しています。それは独立性ではありません。コミュニティの顔をした依存です。Microsoft の戦略の方向性が新しい LSP ホストへ移ると、開発の重心もそちらに移りました。OmniSharp は死んだわけではありませんが、投資の向かう先ではないのです。

ユーザーの **codymullins** は、この問題領域の根底にある懸念を提起しました。

> "Closed tools all get sunset eventually, then we'll have to port all our code. I've worked at places where my whole job was porting from some closed source language that's no longer supported. Better to do it on your own schedule than be forced to unexpectedly. At least with OmniSharp there was a plan b — it wasn't great but it existed."
>
> （クローズドなツールはすべて最終的にサンセット扱いになり、その後はコード全体を移植せねばなりません。サポートが切れたクローズドソース言語からの移植が職務のすべてだった職場もありました。突然強制されるより、自分のスケジュールで進めるほうが良いのです。少なくとも OmniSharp なら plan B がありました。素晴らしいとは言えませんが、存在はしていました。）

### Rider: 優れているがプロプライエタリ

JetBrains Rider は、Windows 上の Visual Studio を除けば .NET 向けに利用できる最良の IDE です。これは本心からの賛辞です。Rider は本当に優れた F# サポート、高速なプロジェクトロード体験、そしてクロスプラットフォームの .NET 開発者が財布で投票してきた UI を備えています。r/fsharp のあるユーザーはこう言いました。

> "The F# intellisense experience in Rider is rock-solid. Rivals Visual Studio. F# feels like a first-class citizen in Rider." — **Jwosty**, r/fsharp
>
> （Rider の F# IntelliSense 体験は鉄壁です。Visual Studio と肩を並べます。Rider では F# が一等市民のように感じられます。）

そして r/dotnet のユーザー **yankun0567** は当然の結論を述べました。

> "Regarding that VS (not Code!) is Windows only, but .NET is cross-platform — it is no surprise that a cross-platform IDE catches up."
>
> （VS（Code ではありません！）が Windows 専用で、.NET がクロスプラットフォームであることを考えれば、クロスプラットフォーム IDE が追いつくのは驚くにあたりません。）

しかし Rider は有料の商用ライセンスが必要です。クローズドソースです。あなたのワークフローは、JetBrains が商業的に維持し、有利な価格設定を保つことに依存しています。VS for Mac 廃止スレッドのユーザー **ffffrozen** は、多くの開発者が共有する願望を表明しました。

> "If Rider had a one-off purchase, I'd buy it in a heartbeat."
>
> （Rider が買い切り型なら、一瞬で買うのですが。）

より広い論点は、Rider が悪いということではありません。プロプライエタリな IDE は、オープンなエコシステムにとって永続的な答えにはならないということです。.NET ランタイムはオープンです。C# コンパイラーはオープンです。F# コンパイラーはオープンです。Language Server Protocol はオープンです。エディターツールもオープンであるべきです。

## 私たちが構築したもの

SharpLsp は約束ではありません。動作するソフトウェアです。最初のエディター統合は VS Code 拡張機能ですが、アーキテクチャは初日から意図的にエディター非依存です。`$PATH` 上にある単一の `sharplsp` バイナリを、LSP に対応するあらゆるエディターが起動できます。

重要なアーキテクチャ上の洞察は、コンパイラーがすでに知っていることを再実装しないということです。私たちはコンパイラーを呼び出します。C# には Roslyn を、F# には FSharp.Compiler.Service を。補完、診断、ホバー、定義へのジャンプ、リネームなど、セマンティックな機能はすべて、薄い IPC ブリッジを介して実際のコンパイラーから得ます。私たちは LSP プロトコル層、仮想ファイルシステム、そして tree-sitter 経由の構文レベル機能を所有します。正しさはコンパイラーが所有します。これは妥協ではなく、正しい設計です。

### Solution Explorer

SharpLsp で .NET ワークスペースを開いたとき最初に目にするのは、本物のソリューションエクスプローラーです。ファイルツリーではなく、`.sln` を理解する階層であり、Visual Studio と同じようにプロジェクト、名前空間、型を理解します。しかも、すべてのプラットフォームのすべてのエディターで利用できます。ツリーは実際の MSBuild プロジェクトグラフから構築されており、フォルダー構造から推測されたものではありません。プロジェクト参照と NuGet 依存関係の違いを理解しており、それをサイドバーに反映します。

これは聞こえるよりも重要です。Visual Studio のソリューションエクスプローラーは、2002 年以来 .NET プロジェクトの心的モデルとなってきました。これは .NET 開発者がコードを考える方法、つまり「フォルダー内のファイル」ではなく「ソリューション内のプロジェクト内の名前空間内の型」を表しています。Windows の Visual Studio と、macOS や Linux のあらゆるツールを行き来するシニアエンジニアは、このモデルの喪失を強く感じます。ファイルツリーベースの代替はすべてコンテキストスイッチを強います。SharpLsp はそのコンテキストスイッチを拒否します。ソリューション階層が主要なナビゲーション面であり、MSBuild から直接導出され、編集中も同期され続けます。

<figure class="article-figure">
  <img src="/assets/screenshots/solution-explorer.png" alt="VS Code 上で MyApp.sln のプロジェクトと名前空間ツリーを表示する SharpLsp のソリューションエクスプローラー">
  <figcaption>実際の .sln ファイルを完全なプロジェクトと型の階層で表示するソリューションエクスプローラー。</figcaption>
</figure>

ツリーは型レベルの構造も反映します。名前空間を展開すると型が表示され、型を展開するとメンバーが表示されます。各ノードにはインラインで参照数が表示され、何が使われていて何がデッドコードになり得るかを継続的なアンビエントシグナルとして示します。気になるシンボルごとに明示的な「すべての参照を検索」を実行する必要はありません。ディスク上のソリューションが変わったとき、たとえば新しいファイルが追加されたり、プロジェクト参照が変更されたりしたときも、再起動なしにツリーが更新されます。

### コードの折りたたみ

ほとんどのエディターでのコード折りたたみは行範囲ベースであり、何を折りたたんでいるかを理解せずに開きカッコから閉じカッコまで折りたたむ鈍器のようなものです。SharpLsp の折りたたみは tree-sitter による実装で、コードの構文形状を理解します。名前空間、型、メソッド、式ブロックは、それぞれ独立して正しく折りたたまれます。

折りたたみ範囲は、コンパイラーサイドカーへのラウンドトリップなしに、Rust ホスト内で完全に計算されます。つまり、ワークスペースのロードが完了しているか、コンパイラーがバックグラウンドビルドの最中であるかを問わず、1 ミリ秒未満で解決されます。折りたたみは構造情報であってセマンティック情報ではありません。SharpLsp はそれをそうしたものとして扱い、最速のハンドラーへルーティングします。

<figure class="article-figure">
  <img src="/assets/screenshots/code-folding.png" alt="名前空間が折りたたまれ、ひと画面に 60 行のコードが見えているコード折りたたみの様子">
  <figcaption>tree-sitter による高速なコード折りたたみ — サブミリ秒で、コンパイラー不要。</figcaption>
</figure>

生成コード、ドメインモデル、Protocol Buffer 実装など、巨大なファイルを扱うエンジニアにとって、行レベルではなく型レベルで折りたためることは、ナビゲーション可能なファイルと、絶え間ないスクロールを要するファイルの違いになります。SharpLsp の C# 用 tree-sitter 文法は、リージョン（それを使うレガシーコードベースとの互換性のため）、ドキュメントコメントブロック、複数行の LINQ 式を含む、すべての標準的な折りたたみパターンを処理します。

### 補完

補完は完全な Roslyn セマンティックモデルから取得します。Visual Studio を支えるのと同じ `CompletionService` です。これは、まだスコープにない型のインポート補完、拡張メソッドの解決、コンストラクタオーバーロード、名前付き引数の提案、アクセシビリティ修飾子による絞り込みを意味します。補完リストはトークン頻度の推測ではなく、実際にコンパイルされたプロジェクトグラフに対する Roslyn のクエリです。

まだインポートされていない型名を入力すると、SharpLsp は自動インポート提案とともに表示します。`.` を入力すると、すべてのインポート済み名前空間からの継承メンバーと拡張メソッドを含む完全なメンバーリストが得られます。LINQ チェーンの中にいるときは、補完コンテキストが要素型を意識し、それに応じてフィルタリングします。これが Roslyn が知っていることであり、SharpLsp はそれをすべてそのまま公開します。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-completions-page.png" alt="Add や Count などのメンバーを完全なセマンティックコンテキスト付きで表示する SharpLsp の補完リスト">
  <figcaption>Visual Studio を支える同じエンジンによる、Roslyn の CompletionService によるセマンティック補完。</figcaption>
</figure>

補完のレイテンシ目標は 50 パーセンタイルで 100ms 未満、95 パーセンタイルで 200ms 未満です。これらの目標を達成するには、サイドカーリクエストのライフサイクルを慎重に管理する必要があります。ユーザーが入力を続けている際にインフライトのリクエストを統合し、もはや関連しなくなった古い補完をキャンセルし、同じドキュメント位置に対する重複したリクエストでコンパイラーが過負荷にならないよう、サイドカーへのラウンドトリップをインテリジェントにデバウンスします。現在の実装は、M2 MacBook Pro 上で 15 プロジェクト構成のソリューションに対するテストでこれらの目標を満たしています。

### ホバーと XML ドキュメント

ホバーはメソッドや型の完全なシグネチャを、XML ドキュメント（パラメーター、戻り値の説明、備考、例外、サンプル）とともに表示します。これはソース内の XML ドキュメントコメントから、あるいはサードパーティ API にホバーした際は NuGet パッケージに埋め込まれたドキュメントからレンダリングされます。Roslyn の `DocumentationCommentCompiler` は、基底クラスやインターフェース実装からの継承ドキュメントを含めて、これらすべてを公開します。

サイドバーに表示される Profiler パネルは飾りではありません。SharpLsp はマシン上で実行中のすべての .NET プロセスを表示するため、何が動いているのかを常に把握できます。パフォーマンス低下を追跡しているとき、あるいはサービスが本当に停止したことを確認したいときに、このアンビエントなプロセス一覧はすぐに役立ちます。Activity Monitor を開いたり、`ps aux | grep dotnet` を実行したりする必要はありません。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-hover-page.png" alt="Factorial メソッドのシグネチャを完全な XML ドキュメントとパラメーター説明付きで表示するホバーツールチップ">
  <figcaption>パラメーターと戻り値のドキュメントを伴う XML ドキュメントコメントをレンダリングするホバー。</figcaption>
</figure>

F# にとって、ホバーは C# よりも構造的に重要です。F# コードは型推論に大きく依存するため、束縛の型はソースに明示的には書かれていないことが多いのです。`|>` 演算子の深くネストしたパイプラインでは、各中間式の型はコンパイラーが推論します。そして、その型情報の唯一の信頼できる出典がコンパイラーです。FSharp.Compiler.Service の `GetToolTip` API はこれら推論された型を公開し、SharpLsp は C# のホバー結果と同じ優先順位とフォーマットでそれらをレンダリングします。F# の束縛にホバーすると、推論された完全な型が表示されます。これはしばしば存在する唯一のドキュメントです。

### 定義へ移動

定義へ移動は、ソリューショングラフ全体にまたがってナビゲートします。プロジェクト参照を通り、別アセンブリで定義された型へ進み、PDB が存在しない NuGet パッケージへも逆コンパイルされたソースを使って入っていきます。パンくずバーは型階層内の現在位置を常に追跡しており、ジャンプ先がどこかが常にわかり、移動履歴を遡って戻ることもできます。

これはテキストの grep でもインデックスの検索でもありません。Roslyn のシンボル解決です。Visual Studio が内部で使用しているのと同じ仕組みです。Roslyn のワークスペースモデルがそれらを考慮しているため、部分クラス、ソースジェネレーター、ネスト型を正しく処理します。ソースジェネレーターで定義されたシンボルに対して定義へ移動を押すと、SharpLsp はジェネレーター実装ではなく、生成されたソースに移動します。BCL の型へ移動するときは、C# サイドカーが ICSharpCode.Decompiler を使ってメタデータを逆コンパイルし、再構築されたソースコードを返します。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-go-to-definition-page.png" alt="メソッド実装にナビゲートし、完全な型パスを表示するパンくずを伴う定義へ移動">
  <figcaption>多階層の型階層をたどって移動する定義へ移動。</figcaption>
</figure>

逆コンパイルされたメタデータへの定義へ移動、つまり `System.Collections.Generic.List<T>` に入って実装を見るという機能は、歴史的に Visual Studio と Rider のみで利用できました。これらのツールにお金を払う価値があった機能のひとつです。なぜなら、不慣れなコードを読みながら docs.microsoft.com のブラウザータブを開いておく必要がなくなるからです。SharpLsp は、このバイナリが動くあらゆるエディターでこれを実現します。

ソリューションエクスプローラーは、同じ構造的理解を反映します。深くネストした型 — 内部クラス、ネストされた列挙型、async メソッドが生成するコンパイラー生成のステートマシン型 — はすべて階層内の正しい位置に表示され、参照数がインラインで示されます。

<figure class="article-figure">
  <img src="/assets/screenshots/nested-classes.png" alt="ソリューションエクスプローラーに参照数付きで表示される Outer、Inner、AnotherInner のネストクラス">
  <figcaption>ソリューションエクスプローラーでの参照数とネスト型サポート。</figcaption>
</figure>

### 診断

診断は本物の Roslyn コンパイラーから来ます。近似でも、tree-sitter のヒューリスティックでも、ソーステキストへの正規表現でもありません。表示されるすべてのエラーと警告は、完全にロードされた `MSBuildWorkspace` からの本物の Roslyn 診断です。コードがコンパイルできるかを判定する解析エンジンと、診断パネルを生成するエンジンは同じです。

SharpLsp は [LSP 3.17 のプル診断モデル](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_diagnostic) を採用しています。これは、診断はエディターが要求したときにのみ計算されることを意味します。プロジェクトグラフが不完全でパッケージがまだ復元されていないワークスペースのロード中に、推測でプッシュされることは決してありません。これは、長年にわたり VS Code 上の C# ツールを悩ませてきた「ファントムエラー」問題を解決します。OmniSharp で大きなソリューションを開き、パッケージがロードされるにつれ何百もの CS0246 エラーが現れては消えるのを見たことがある人なら、なぜこれが重要かを正確にご存知でしょう。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-diagnostics-page.png" alt="ファイルと行参照付きで本物の Roslyn コンパイラーエラーを表示する診断パネル">
  <figcaption>本物の Roslyn 診断を、必要なときに引き出し、早すぎるプッシュは行いません。</figcaption>
</figure>

NuGet 復元ゲートは、`MSBuildWorkspace` がソリューションを開く前に実行されます。SharpLsp は欠落したパッケージ復元状態を検出し、`dotnet restore` を自動的に実行し、その後にのみセマンティックリクエストの提供を開始します。初回オープン体験は、即座に空の状態を返すよりわずかに長くかかります。トレードオフは、そのゲートを通過した後にエディターが受け取るすべての診断が本物であることです。ワークスペースのロードが完了していないという理由だけで存在する赤い波線はありません。これは、.NET 開発者が期待し、歴史的には Visual Studio や Rider でのみ得られていた挙動です。これらのツールでは、ビルドシステムとの統合により、IDE が解析を始める前にパッケージが揃っていることが保証されます。

### クイックフィックスとリファクタリング

コードアクションは Roslyn 自身の `CodeFixProvider` と `CodeRefactoringProvider` の実装から来ます。Visual Studio の電球メニューを支えるのと同じプロバイダーであり、何十億行もの C# コードに対する 10 年以上の本番運用で磨かれてきました。未使用変数の削除、欠落した `using` の追加、インターフェースの実装、シンボルのリネーム、メソッドの抽出など、これらはすべて SharpLsp が同じ API を呼び出しているからこそ動作します。ゼロから再実装してはいません。

これは、サードパーティの Roslyn アナライザーが自動的に動作することも意味します。プロジェクトが Roslyn アナライザーの NuGet パッケージ — StyleCop、Roslynator、ErrorProne.NET — を参照していれば、その診断ルールとコード修正は追加の設定なしに SharpLsp のアクションメニューに表示されます。アナライザーパイプラインは Roslyn がコンパイル中に実行するのと同じものです。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-refactoring.png" alt="未使用変数の削除、修正、説明オプションを表示するクイックフィックスの電球">
  <figcaption>エディターのアクションメニューに直接表示される、Roslyn によるクイックフィックス。</figcaption>
</figure>

任意のコンテキストで利用可能なコードアクションのリストは、Visual Studio が同じコンテキストで提供するものと同一です。なぜなら「カーソル位置と診断スパン」から「利用可能なアクション」へのコードパスが同一だからです。私たちはドキュメント、位置、診断コンテキストを Roslyn の `CodeFixContext` に渡します。あとは Roslyn がやります。Visual Studio のリファクタリングメニューとの機能的同等性は願望ではなく、設計の帰結です。

### プロジェクトコンテキストメニュー

ソリューションエクスプローラーでプロジェクトを右クリックすると、ビルド、リビルド、クリーン、NuGet ブラウジング、プロジェクト参照管理が利用できます。すべて配線されており、動作します。これらはシェルコマンドの薄いラッパーではありません。SharpLsp サーバーを経由するため、ソリューションの状態を認識でき、参照が変更されるとプロジェクトグラフを更新できます。

ビルド出力は専用パネルに表示され、LSP ログとは混ざりません。ビルドからのエラーは、Visual Studio のエラーリストと同じように、エディター内のソース位置にリンクして戻ります。コンテキストメニューからプロジェクト参照を追加すると、`MSBuildWorkspace` が新しい依存関係を反映するように更新され、ソリューションエクスプローラーのツリーは完全な再起動を要さずにその参照を表示するように更新されます。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-context-menu-open-project.png" alt="ビルド、リビルド、クリーン、NuGet パッケージのブラウズ、プロジェクト参照の追加オプションを表示するプロジェクトコンテキストメニュー">
  <figcaption>ソリューションエクスプローラーのコンテキストメニューから直接実行できるプロジェクトレベルのアクション。</figcaption>
</figure>

プロジェクトファイルの変更は `Microsoft.Build.Construction`、つまり MSBuild ドキュメントモデル API を経由します。文字列操作ではありません。SharpLsp が `<PackageReference>` 要素を追加すると、それはプロジェクトファイルの XML DOM に正しい位置で挿入され、既存ファイルと一貫したフォーマットで整形され、空白やコメントを乱すことなくシリアライズし戻されます。これは厳格なルールです。SharpLsp は構造化ファイルを手作業で操作することは決してありません。

### NuGet 管理

NuGet パネルは完全なパッケージブラウザーです。nuget.org（または `nuget.config` 経由で構成された任意のパッケージソース）を検索し、利用可能なバージョンをブラウズし、現在インストールされているものを確認し、パッケージメタデータを点検できます。エディターを離れることもターミナルを開くこともなく、すべて行えます。検索結果は NuGet v3 API からライブで取得され、ダウンロード数、ライセンス識別子、バージョンリスト付きでパッケージを返します。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-search.png" alt="ダウンロード数付きで Serilog パッケージの検索結果を表示する NuGet ブラウザー">
  <figcaption>nuget.org からライブで結果を取得する NuGet パッケージ検索。</figcaption>
</figure>

パッケージ管理は、Visual Studio 以外のエディターを使う .NET 開発者にとって常に摩擦点でした。VS Code のワークフローは通常、ターミナル（`dotnet add package Serilog`）を使うか、`.csproj` を手で編集して復元を待つかのどちらかです。どちらも、即時フィードバック付きの検索＆クリック UI ほど速くはありません。SharpLsp はその UI をすべてのエディターに届けます。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-installed.png" alt="Newtonsoft.Json を説明とバージョン付きで表示する NuGet インストール済みパッケージパネル">
  <figcaption>アクティブプロジェクトに含まれているものを表示するインストール済みパッケージタブ。</figcaption>
</figure>

インストール済みパッケージビューのデータは MSBuild プロジェクトグラフ、具体的には NuGet 復元グラフを通じて解決された `PackageReference` 項目から派生しています。つまり、UI 側のキャッシュではなく、プロジェクトファイルの実際の状態を反映します。ターミナルからパッケージを追加した後にパネルを開けば、新しいパッケージはそこにあります。`.csproj` を直接編集すれば、次回の更新時にパネルがその変更を反映します。

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-package-details.png" alt="Newtonsoft.Json のライセンス、プロジェクト URL、バージョンを表示する NuGet パッケージ詳細パネル">
  <figcaption>ライセンス、メタデータ、インストール／削除アクション付きのパッケージ詳細。</figcaption>
</figure>

パッケージ詳細には SPDX ライセンス識別子、プロジェクト URL、作者情報、構成済みフィードでの完全なバージョン履歴が含まれます。これは Visual Studio の NuGet パッケージマネージャーで利用できる詳細レベルであり、いまや単一の共有サーバープロセスを介して、すべての LSP 対応エディターで利用できます。

## アーキテクチャ

SharpLsp は 3 層システムです。Rust ホストが LSP 接続、仮想ファイルシステム、そして [tree-sitter](https://tree-sitter.github.io/tree-sitter/) 経由のすべての構文レベルの作業を所有します。2 つの長期実行 .NET サイドカープロセスがセマンティック解析を担当します。C# 用は Roslyn 経由、F# 用は FSharp.Compiler.Service 経由です。

ホストを Rust で構築するという判断は、目新しさによる選択ではありません。Rust は tokio によるゼロコストの非同期ランタイム、複数エディターの共有サーバーシナリオに対する fearless concurrency、そしてサイドカーが接続する前に 50ms 未満で起動しメモリ消費がほぼゼロのバイナリを与えてくれます。ホストは LSP メッセージを処理し、仮想ファイルシステムを管理し、リクエストをルーティングし、tree-sitter のパースを処理します。ガベージコレクトされるサイドカープロセスを邪魔するような形でヒープに触れることはありません。

セマンティック解析を .NET に保つ判断も、同じく意図的なものです。Roslyn はマネージドランタイムライブラリです。FSharp.Compiler.Service もマネージドランタイムライブラリです。どちらも各言語の洗練され、よくメンテナンスされた実装で、背後には数十年のエンジニアリングがあります。これらを別の言語で再実装するのは正気の沙汰ではありません。代わりに私たちは呼び出します。サイドカーは長期実行 .NET プロセスで、完全な MSBuildWorkspace をロードし、メモリ内のコンパイラー状態を維持し、Rust ホストからの IPC リクエストに応答します。

Rust とサイドカー間の IPC は Unix ドメインソケット（Windows では名前付きパイプ）上の MessagePack を使用し、4 バイトのリトルエンディアン長プレフィックスでフレーミングされています。ローカルベンチマークでの IPC ラウンドトリップオーバーヘッドは一貫して 200µs 未満で、ボトルネックは常にコンパイラー操作であって、トランスポートではありません。IPC を含む合計ラウンドトリップオーバーヘッドの目標は、コンパイラー作業を除いて 500µs 未満です。

構文のみのリクエスト — ドキュメントシンボル、折りたたみ範囲、選択範囲 — は Rust ホスト内で tree-sitter を使って完全に処理されます。ソリューションのサイズに関わらず 5ms 未満で返ります。セマンティックリクエストはサイドカーに送られ、150ms のデバウンスウィンドウで統合されます。同じドキュメントの新しいバージョンによって置き換えられた古いインフライトリクエストはキャンセルされます。

| カテゴリ | ハンドラー | レイテンシ目標 | 例 |
|----------|---------|---------------|----------|
| 構文のみ | Rust (tree-sitter) | &lt;5ms | documentSymbol, foldingRange, selectionRange |
| セマンティック | サイドカー (Roslyn/FCS) | &lt;200ms | completion, hover, definition, references |
| ハイブリッド | Rust + サイドカー | &lt;100ms | semanticTokens |
| キャッシュ | Rust (salsa) | &lt;1ms | 変更されていないドキュメントの繰り返しリクエスト |

**SharpLsp のすべてのバイナリは、マシン上の単一の中央場所に存在します。** `$PATH` 上の `sharplsp` だけが、どのエディターにも必要なものです。エディター拡張機能は、システムバイナリを起動する薄いクライアントです。バンドルされた実行ファイルはゼロです。1 度のインストールで VS Code、Neovim、Helix、Zed、その他あらゆる LSP 対応エディターに同時にサービスを提供します。

これは、現在のエコシステムの、より不条理な側面のひとつを解決します。すべてのエディター拡張機能が、自前の言語サーバーバイナリのコピーをバンドルしているという問題です。OmniSharp の VS Code 拡張機能はバンドルされた OmniSharp バイナリを出荷します。Ionide 拡張機能は独自の F# 言語サーバーのビルドを出荷します。これらのバイナリは拡張機能ごと、エディターごと、マシンごとにダウンロードされます。プロセスを共有しません。キャッシュも共有しません。VS Code と Neovim を同じソリューションに対して同時に使う開発者は、理論上は OmniSharp の 2 つの別インスタンスを実行していることになります。それぞれが独自の Roslyn ワークスペースのコピーをメモリ上に持っているのです。SharpLsp はソリューションごとに 1 プロセスを実行し、マシン上のすべてのエディターで共有します。

## F# は後付けではありません

Microsoft の廃止発表は、Mac の F# 開発者に Windows VM を実行するよう告げました。C# Dev Kit には F# サポートがありません。Issue #5276 の Language Server Protocol 発表は F# について一度も触れていませんでした。OmniSharp の F# ストーリーは常に二番手でした。コミュニティは何年もこの状況を受け入れてきました。代替案がなかったからです。SharpLsp はそれを拒否します。

Windows と Rider 以外での F# ツールの状態は、長年にわたるフラストレーションの源であり、言語の採用を実測可能なペースで遅らせてきました。r/fsharp の Reddit スレッド「[Editing F#: A big issue preventing adoption and onboarding](https://www.reddit.com/r/fsharp/comments/bngxxz/editing_f_a_big_issue_preventing_adoption_and/)」は 2019 年にこの主張をまとめており、今日も同じく当てはまります。ユーザーの **flubahdubah** はこう書いています。

> "I'm here to make the argument that fixing the editor tooling should be a higher priority item to fix for the F# team, ahead of some of the current release items that (while appreciated and important) do not fix as large of an issue. We use editor tooling in every single programming task — versus a language feature which might only be present in certain programming tasks. Having a base set of reliable editing features can signal the maturity of a language's ecosystem."
>
> （F# チームにとってエディターツールの修正は、現在のリリース項目の一部（それらは評価に値し重要ですが）よりも優先度の高い修正対象であるべきだと主張するためにここにいます。エディターツールはあらゆるプログラミング作業で使います。一方、言語機能は特定のプログラミング作業でしか登場しないこともあります。信頼できる編集機能の基本セットがあることは、言語エコシステムの成熟度を示すシグナルになり得ます。）

同じスレッドの匿名コメンターは、F# と型推論について構造的に重要なことを指摘しました。

> "Another issue is that since most F# code uses type inference so heavily, it's even more important than normal to have an editor with IDE features, so you can tell what types things are. Code you wrote a long time ago, or someone else's code, that doesn't have type annotations is completely impenetrable without a code editor that can show you the types in some way, and let you hop to definition."
>
> （もうひとつの問題は、F# コードの大半が型推論を非常に多用するため、何の型なのかを知るために IDE 機能を備えたエディターを持つことが、通常より一層重要になることです。型注釈のない、ずっと前に自分が書いたコードや他人のコードは、型を何らかの形で表示し、定義へジャンプさせてくれるコードエディターなしには、まったく解読不能です。）

このため、F# エディターの品質は単なる QoL の問題ではなく、正しさの問題なのです。ホバーで正確な型表示がなければ、推論に大きく依存する F# コードは本当に読みづらく保守しづらくなります。エディターは便利な道具ではなく、ドキュメントそのものです。エディターが遅い、負荷でクラッシュする、ファイル変更後に型を見失うときには、言語そのものへのアクセス性が落ちてしまいます。

最近の r/fsharp エディタースレッドのユーザー **bozhidarb** は、より広い問題を明確に表現しました。

> "I'm not sure the support for F# in NeoVim is very good — I played with OCaml there and the indentation was quite broken when using TreeSitter. I checked Helix briefly and the support story there wasn't very good either. That's a big problem with smaller communities — the languages are great, but the support for them in editors is all over the place."
>
> （NeoVim の F# サポートが本当に良いかは怪しいです。そこで OCaml を試しましたが、TreeSitter 使用時のインデントはかなり壊れていました。Helix を少し見ましたが、サポート状況も良いとは言えませんでした。これは小規模コミュニティの大きな問題で、言語は素晴らしいのに、エディターのサポートはばらばらなのです。）

そして F# ツール状態スレッドのユーザー **verdadkc** は、現在の状況が作り出すオンボーディング障壁について次のように述べました。

> "Learning a new language is the fun and easy part. Learning a new tooling ecosystem is daunting and tedious. I would love to see a course on .NET for people who are entirely new to .NET and have no intention of ever using Visual Studio."
>
> （新しい言語を学ぶのは楽しく簡単な部分です。新しいツールエコシステムを学ぶのは、気が重く退屈です。.NET 完全初心者で、Visual Studio を使うつもりが一切ない人向けの .NET コースがあれば、ぜひ見てみたいです。）

SharpLsp はこれに正面から取り組みます。C# と F# は同じインフラ層を共有します。同じ機能目標に向かいます。同じ基準でテストされます。F# は後付けのボルトオンではなく、初日から第一級のターゲットです。

F# サイドカーは、プロジェクト解析に [Ionide.ProjInfo](https://github.com/ionide/proj-info)、リンティングに [FSharpLint](https://github.com/fsprojects/FSharpLint) を併用しつつ、[FSharp.Compiler.Service](https://www.nuget.org/packages/FSharp.Compiler.Service) を実行します。F# 固有の機能 — パイプラインの型ヒント（`|>` チェーンでの中間型のインライン表示）、ユニオンケースの生成、レコードのスタブ補完、計算式の補完、`.fsproj` におけるファイル順序の認識、NuGet 参照補完を伴う `.fsx` スクリプトサポート — は、将来の「あれば良いもの」ではなく、最優先の項目としてロードマップに載っています。

私たちが構築している基準は、**Jwosty** が r/fsharp で Rider の F# サポートについて述べたものです。

> "The F# intellisense experience in Rider is rock-solid. Rivals Visual Studio. F# feels like a first-class citizen in Rider."
>
> （Rider の F# IntelliSense 体験は鉄壁です。Visual Studio と肩を並べます。Rider では F# が一等市民のように感じられます。）

私たちはそれを、オープンソースで、すべてのプラットフォームのすべてのエディター向けに構築しています。新機能を追加するときは、F# も C# と同時に手に入ります。

## なぜオープンソースの所有権が重要か

#5276 の発表に対するコミュニティのフラストレーションは、オープンソースに関する抽象的なイデオロギーではありませんでした。それはコントロールに関するもの — 具体的には、自分のツールが次に何をするかを予測する力、それが壊れたときにフォークする力、ベンダーが方向転換したときに移行する力の喪失でした。スレッドで **codymullins** はこう言いました。

> "Closed tools all get sunset eventually, then we'll have to port all our code. I've worked at places where my whole job was porting from some closed source language that's no longer supported. Better to do it on your own schedule than be forced to unexpectedly."
>
> （クローズドツールはすべて最終的にサンセット扱いになり、その後はコード全体を移植せねばなりません。サポートが切れたクローズドソース言語からの移植が職務のすべてだった職場もありました。突然強制されるより、自分のスケジュールで進めるほうが良いのです。）

このパターンは業界全体で繰り返されます。商用ベンダーが優れたツールを提供する。コミュニティはそれに依存するようになる。ベンダーが価格を変え、ライセンス条件を変え、機能を廃止し、製品の方向性を転換する。コミュニティは慌てる。これは Visual Studio for Mac で起きました。Xamarin で起きました。.NET のクロスプラットフォームストーリー全般でも、.NET Core の背後にあるコミュニティの圧力が Microsoft の手を強制するまでに起きました。

オープンソースは品質の保証ではありません — OmniSharp にもバグがありました。しかし、継続性と制御の保証ではあります。ソースコードが存在し、MIT ライセンスであれば、コミュニティは許可なくフォークし、メンテナンスし、改善し、他のツールに統合できます。どの一企業も、それを一夜にして廃止することはできません。

SharpLsp は MIT ライセンスです。完全なソースは [GitHub](https://github.com/Nimblesite/SharpLsp) にあります。クローズドソースコンポーネントはなく、エンタープライズライセンス制限もなく、Microsoft アカウントの要件もありません。あらゆる規模の組織が、商用利用から排除されることはありません。サインすべきものは何もありません。

## 次は何か

フェーズ 2 が進行中です。両言語の完全なセマンティック解析です。つまり、補完、ホバー、定義へ移動、参照検索、診断、リネーム、セマンティックトークンが、C# のための実際の MSBuildWorkspace でロードされたソリューション、F# のための FCS でロードされたプロジェクトに対して動作するということです。

その後はコードアクションとリファクタリング（フェーズ 3）、テストの検出とデバッグ（フェーズ 4）、そして最終的には他のオープンソースツールが提供したことのない機能 — 同じソリューション内の C# プロジェクトと F# プロジェクト間のクロス言語ナビゲーション、アーキテクチャ解析、MCP 経由の AI 支援コードアクション（フェーズ 5）が続きます。

クロス言語ナビゲーション機能は特筆に値します。実世界の .NET ソリューションでは、C# プロジェクトと F# プロジェクトが並んで存在することが一般的です。たとえば、F# のドメインモデルライブラリを C# の ASP.NET Core API が使用するといった具合です。F# 型への C# 呼び出しに対して定義へ移動を実行すると、現在のあらゆるオープンソースツールではメタデータスタブで止まります。SharpLsp は言語境界を越えて定義を解決し、リクエストを対象ファイルを所有するサイドカーへルーティングし、実際の F# ソース位置を返します。これはオープンソース LSP 実装ではこれまで実現されたことがありません。

完全なロードマップは [技術仕様](/docs/specs/sharplsp-spec.md) にあります。コードは [GitHub](https://github.com/Nimblesite/SharpLsp) にあります。

SharpLsp が存在するのは、.NET 開発者が、プロプライエタリなライセンス、ベンダーロックイン、あるいは単一エディターへの結合の背後に閉じ込められない、世界水準のツールを受けるに値するからです。コミュニティは 10 年以上、回避策を構築してきました。私たちは回避策の構築を終わりにします。本物を一緒に作りに来てください。
