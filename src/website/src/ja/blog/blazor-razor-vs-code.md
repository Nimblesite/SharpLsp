---
layout: layouts/blog.njk
title: "VS Code での Blazor と Razor：.razor ファイルのための C# ツール"
description: "SharpLsp は VS Code で Blazor コンポーネント、Razor Pages、MVC ビューを編集できるようになりました：.razor ファイルと .cshtml ファイルでの C# のホバー、補完、診断、定義へ移動、名前の変更。"
lang: ja
date: 2026-10-20
author: SharpLsp チーム
image: /assets/images/blog/blazor-razor-vs-code.png
imageAlt: "VS Code の Blazor コンポーネントのマークアップ内に表示された C# のホバーと、その横の「Blazor and Razor in VS Code」という見出し"
tags:
  - posts
  - blazor
  - razor
  - csharp
  - dotnet-lsp
category: announcement
excerpt: "Blazor コンポーネント、Razor Pages、MVC ビューが、C# ファイルと同じ Roslyn エンジンを使えるようになりました：マークアップの中で、ホバー、補完、診断、定義へ移動、参照、名前の変更が使えます。"
---

SharpLsp は Razor を理解するようになりました。Blazor コンポーネント（`.razor` ファイル）、Razor Pages、MVC ビュー（`.cshtml` ファイル）が、残りの C# と同じ Roslyn エンジンを使えるようになりました。マークアップの中で、ホバー、補完、診断、定義へ移動、参照、名前の変更が使えます。このサポートは現在 `main` にあり、次のリリースで提供されます。

小さな Blazor Web App で見てみましょう。

{% video "blazor" %}

## Blazor とは？Blazor と Razor を 1 分で

2 つの名前は別の層を指しているため、混同しやすいのです。

- **Razor** は構文です。HTML と C# を混ぜ合わせます。`@` 式、`@if` や `@foreach` のブロック、`@code` ブロックなどです。Microsoft の [Razor 構文リファレンス](https://learn.microsoft.com/ja-jp/aspnet/core/mvc/views/razor?view=aspnetcore-10.0)がそのすべてを説明しています。
- **ASP.NET Core の Razor Pages と MVC ビュー**は、リクエストごとにサーバーがレンダリングする `.cshtml` ファイルです。[ASP.NET Core の Razor Pages](https://learn.microsoft.com/ja-jp/aspnet/core/razor-pages/?view=aspnetcore-10.0)と [ASP.NET Core MVC のビュー](https://learn.microsoft.com/ja-jp/aspnet/core/mvc/views/overview?view=aspnetcore-10.0)をご覧ください。
- **Blazor** はコンポーネントフレームワークです。[Razor コンポーネント](https://learn.microsoft.com/ja-jp/aspnet/core/blazor/components/?view=aspnetcore-10.0)は `.razor` ファイルです。Blazor Web App は .NET 8 以降の `dotnet new blazor` テンプレートで、コンポーネントをサーバー上またはブラウザー内の WebAssembly で実行します。各コンポーネントは[レンダーモード](https://learn.microsoft.com/ja-jp/aspnet/core/blazor/components/render-modes?view=aspnetcore-10.0)を選びます。静的なサーバーレンダリング、`InteractiveServer`、`InteractiveWebAssembly`、`InteractiveAuto` です。

この 3 つすべての下に、すべての Razor ファイルを C# に変換する 1 つの Razor コンパイラーがあります。だからこそ、SharpLsp の 1 つの実装が Blazor Server、Blazor WebAssembly、Razor Pages、MVC のすべてに対応します。

## .razor ファイルで得られるもの

以下はすべて、動画のデモの `Basket.razor` ページで示したものであり、それぞれが自動テストでカバーされています。

- **ホバー。** `@Total()` にホバーすると、Roslyn が `Basket.Total()` のシグネチャーと XML サマリーを表示します。レイアウトの `@Body` にホバーすると、それがレンダリングする `LayoutComponentBase.Body` プロパティが表示されます。
- **補完。** `@` 式と `@code` ブロックの中で、Roslyn によるメンバーの補完が働きます。編集はすべて `.razor` ファイルに反映され、補完が追加する `using` は `@using` 行になります。
- **診断。** C# の誤りは、その原因となった Razor の行に、コンパイラーのコードとともに、エディターと問題パネルに報告されます。ソリューション全体のスキャンには Razor ファイルも含まれます。
- **定義へ移動。** `@onclick="() => Add(product)"` の `Add` で F12 を押すと、`@code` ブロックに移動します。`Catalog.Products` で F12 を押すと `Catalog.cs` が開きます。C# 側から、`app.MapRazorComponents<App>()` の `App` で F12 を押すと、生成されたクラスではなく `App.razor` が開きます。
- **参照とハイライト。** Razor ファイル内のすべての使用箇所を表示し、コンパイラーが生成した隠れた足場のコードは含みません。
- **名前の変更。** `@code` のフィールドの名前を変更すると、マークアップ内のすべての使用箇所が追従します。
- **構造。** 複数行の要素と `@code` ブロックが折りたためるほか、アウトラインがディレクティブと要素を一覧表示し、開始タグの名前を変更すると終了タグも変わります。
- 呼び出しの中の**シグネチャヘルプ**と、ファイル内の C# に対する**セマンティックハイライト**。

C# を囲むマークアップは、やはり HTML です。VS Code では、SharpLsp が要素と属性の補完、および HTML のホバーを VS Code 自身の HTML 言語サービスへ転送します。C# の断片をすべて空白にした HTML ビューを送るため、HTML サービスが C# をマークアップと取り違えることはありません。

## 仕組み：Razor コンパイラーこそが信頼できる唯一の情報源

Razor ツールを作るとき、つい Razor パーサーを書いてしまいがちです。SharpLsp はそうしません。Razor のセマンティクスは Razor コンパイラーに属しており、2 つ目のパーサーはリリースのたびにそれからずれていきます。

.NET 6 以降、[Razor コンパイラーは C# のソースジェネレーターです](https://learn.microsoft.com/ja-jp/aspnet/core/release-notes/aspnetcore-6.0?view=aspnetcore-10.0#razor-compiler-updated-to-use-source-generators)。それは .NET SDK に同梱され、C# サイドカーのデザインタイムビルドが `dotnet build` とまったく同じように実行します。ジェネレーターは各 Razor ファイルを C# クラスに変換します。C# の断片はすべて、Razor のテキストを指し示す[拡張された `#line` ディレクティブ](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-10.0/enhanced-line-directives.md)の中に、そのままそのクラスへコピーされます。

SharpLsp はこれらのディレクティブから双方向のマップを作ります。

1. Razor の位置へのリクエストは、生成された C# の同じ文字にマップされます。
2. Roslyn がそこで応答します。`.cs` ファイルの場合とまったく同じです。
3. 応答内のすべての位置が、Razor ファイルへ逆マップされます。

マップはディレクティブを鵜呑みにはしません。Roslyn はマップされた各スパンの終端を、断片の 1 文字先として報告するため、SharpLsp は Razor のテキストと生成されたテキストを 1 文字ずつ比較して、すべての断片を測ります。マークアップをレンダリングする `__builder` 呼び出しのように、ジェネレーター自身が書いたコード内の位置には Razor のテキストがなく、利用者に届くことはありません。

ジェネレーターがコンパイラー自身のものであるため、それがマップするあらゆる構文の中の C# が同じ扱いを受けます。`@bind` の値、イベントハンドラー、ジェネリックコンポーネント、`@code` ブロックも含まれます。折りたたみ、アウトライン、リンクされた編集、HTML ビューを駆動するマークアップ側は、再実装ではなく、コンパイラーの公開された[中間表現](https://github.com/dotnet/razor)から来ています。

## 作りながら見つけたこと

新しい `dotnet new blazor` アプリで実際のホストを動かすと、1 つの誤報告が見つかりました。`_Imports.razor` のすべての `@using` が、不要なものとして淡色表示されていたのです。Roslyn は各ファイル自身の生成された C# しか見ないため、インポートファイルの using が、その隣や下にあるコンポーネントに役立っていることを知りません。コンポーネント自身の using も、マークアップだけがそれを必要とする場合には同じ問題を抱えていました。現在、Razor ファイルは不要な using を報告せず、C# ファイルはコードビハインドを含めて引き続き報告します。

2 つ目の発見は SDK のバージョンについてです。Razor ジェネレーターはプロジェクトをビルドする SDK に由来し、`global.json` で別のバージョンを固定していない限り、インストールされている最新のものが使われます。SDK 10.0.401 のジェネレーターは、SharpLsp が同梱する Roslyn より新しいバージョンを必要とするため、その Razor ファイルでは C# の機能が使えません。[Issue #399](https://github.com/Nimblesite/SharpLsp/issues/399) で修正を追跡しています。修正が入るまでは、[Blazor と Razor のドキュメント](/ja/docs/blazor/)に示すとおり、`global.json` で SDK 10.0.303 を固定してください。

## .NET 10 の Blazor：Server、WebAssembly、Razor クラスライブラリ

SharpLsp は、ソリューションに既にあるプロジェクトを読み取ります。どれも `Microsoft.NET.Sdk.Web`、`Microsoft.NET.Sdk.BlazorWebAssembly`、`Microsoft.NET.Sdk.Razor` を通じて同じように読み込まれます。

- Blazor Server または Blazor WebAssembly の対話性を持つ Blazor Web App
- スタンドアロンの Blazor WebAssembly アプリ
- Razor Pages または MVC のアプリ
- 共有コンポーネントの [Razor クラスライブラリ](https://learn.microsoft.com/ja-jp/aspnet/core/razor-pages/ui-class?view=aspnetcore-10.0)

[.NET 10](https://devblogs.microsoft.com/dotnet/announcing-dotnet-10/) SDK 上の ASP.NET Core 10 は検証済みで、新しい `dotnet new blazor` アプリも含まれます。net8.0 と net9.0 のプロジェクトも同じソースジェネレーターで Razor をコンパイルするため動作するはずですが、まだ検証していません。.NET 6 より前のプロジェクトはソースジェネレーターなしで Razor をコンパイルするためサポート対象外であり、.NET Framework の MVC 5 と Web Forms も同様です。

## 今後の予定

このリリースは Razor ファイル内の C# を対象にしています。次はマークアップ自体で、[issue #397](https://github.com/Nimblesite/SharpLsp/issues/397) で追跡しています。

- コンポーネントタグ、コンポーネントパラメーター、`@bind-Value`、`@onclick` などのディレクティブ属性に対するホバー、定義へ移動、補完、参照
- 未知のコンポーネントなど、コンパイラー自身の `RZ` 診断
- `asp-for` など、Razor Pages と MVC ビューのタグヘルパー
- Blazor フロントエンドの背後にある F# ライブラリ：Razor からの F# の型に対するホバー、補完、定義へ移動、および Razor の使用箇所にまで届く F# の名前の変更
- フォーマット、コンポーネントの抽出などのコードアクション、ホットリロード

## 試してみる

1. [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) から、または Cursor、Windsurf、VSCodium では [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) から SharpLsp をインストールします。Razor のサポートは次のリリースで提供されます。
2. `dotnet new blazor -o BlazorDemo` で Blazor Web App を作成し、そのフォルダーを開きます。
3. `Components/Pages/Counter.razor` を開き、`currentCount` にホバーします。

[Blazor と Razor のドキュメント](/ja/docs/blazor/)には、すべての機能、サポートするプロジェクト、まだサポートしていない項目が掲載されています。

## 参考資料

- [ASP.NET Core Blazor](https://learn.microsoft.com/ja-jp/aspnet/core/blazor/?view=aspnetcore-10.0)と [Blazor のホスティングモデル](https://learn.microsoft.com/ja-jp/aspnet/core/blazor/hosting-models?view=aspnetcore-10.0)
- [Blazor プロジェクトの構造](https://learn.microsoft.com/ja-jp/aspnet/core/blazor/project-structure?view=aspnetcore-10.0)と [Blazor のレンダーモード](https://learn.microsoft.com/ja-jp/aspnet/core/blazor/components/render-modes?view=aspnetcore-10.0)
- [Blazor のデータバインディング](https://learn.microsoft.com/ja-jp/aspnet/core/blazor/components/data-binding?view=aspnetcore-10.0)と[イベント処理](https://learn.microsoft.com/ja-jp/aspnet/core/blazor/components/event-handling?view=aspnetcore-10.0)
- [.NET 10 の ASP.NET Core の新機能](https://learn.microsoft.com/ja-jp/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0)
- [ASP.NET Core のタグヘルパー](https://learn.microsoft.com/ja-jp/aspnet/core/mvc/views/tag-helpers/intro?view=aspnetcore-10.0)
- [dotnet/razor リポジトリ](https://github.com/dotnet/razor)と [dotnet/aspnetcore リポジトリ](https://github.com/dotnet/aspnetcore)
- [Embedded Programming Languages](https://code.visualstudio.com/api/language-extensions/embedded-languages) — リクエスト転送についての VS Code ガイド
