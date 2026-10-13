---
layout: layouts/blog.njk
title: "Test Explorer の Microsoft.Testing.Platform (MTP)：C# と F# の dotnet test、xUnit v3、MSTest、NUnit"
description: "SharpLsp の VS Code Test Explorer は、C# と F# の Microsoft.Testing.Platform (MTP) テストを VSTest と並行して検出、実行、デバッグし、カバレッジを収集します。MTP での dotnet test、導入方法、修正した不具合を説明します。"
lang: ja
date: 2026-09-22
author: SharpLsp チーム
image: /assets/images/blog/microsoft-testing-platform-mtp-dotnet-test-csharp-fsharp.png
imageAlt: C# と F# の xUnit v3、MSTest、NUnit テストを SharpLsp Test Explorer に表示する dotnet test モジュール
tags:
  - posts
  - testing
  - csharp
  - fsharp
  - dotnet-lsp
category: testing
excerpt: "xUnit v3 4.0 は Microsoft.Testing.Platform 専用です。VSTest 専用の Test Explorer ではツリーが空になります。SharpLsp は C# と F# で MTP と VSTest を並行実行し、検出、▶、デバッグ、カバレッジに対応しました。"
---

`dotnet test` の仕組みが変わりつつあります。**Microsoft.Testing.Platform (MTP)** は **VSTest** に代わる新しいテストプラットフォームです。テストプロジェクトは、自分でテストを検出・実行する*実行可能なテストモジュール*としてビルドされます。別の `testhost` プロセスや中間のアダプターはありません。MSTest、NUnit、xUnit はいずれも MTP ランナーを提供し、**xUnit v3 4.0 が対応するのは MTP v2 *だけ***です。VSTest アダプターはありません。

そのため、VSTest にしか対応しないエディターの Test Explorer では、新しい xUnit v3 プロジェクトの**ツリーが空**になります。テストは存在し、`dotnet test` では実行できます。それでもエディターには表示されません。

SharpLsp の Test Explorer は両方に対応しました。この機能は現在 `main` にあり、次のリリースに含まれます。**C# と F# の xUnit v3、MSTest、NUnit** の MTP テストモジュールを検出、実行、デバッグし、コードカバレッジを収集します。VSTest プロジェクトとの並行利用は、両者を含むマルチルートワークスペースでも動作します。この記事では次を説明します。

- Microsoft.Testing.Platform での `dotnet test` の仕組み
- C# または F# プロジェクトのオプトイン方法
- Test Explorer でできること
- 信頼できる動作にするため修正した実際の不具合

## Valentin Dide さんに感謝

この機能は、**[Valentin Dide (@validide)](https://github.com/validide)** さんが空のツリーに遭遇し、[issue #249「Test Explorer の Microsoft.Testing.Platform (MTP) 対応」](https://github.com/Nimblesite/SharpLsp/issues/249)を報告してくれたことから始まりました。さらに [PR #250「Test Explorer の Microsoft.Testing.Platform 対応」](https://github.com/Nimblesite/SharpLsp/pull/250)で、次の実装も担ってくれました。

- MTP の検出
- `--list-tests json` によるテスト検出
- `--filter-uid` による実行
- TRX による結果の取得
- MTP モジュール用のデバッグプロファイル
- 両言語の全フレームワークを含む 6 プロジェクトのエンドツーエンドフィクスチャ

この記事で説明する作業はすべて、その PR の上に成り立っています。Valentin さん、ありがとうございます。オープンソースの .NET ツール開発の力を示す貢献です。

## MTP と VSTest の違い

**VSTest** では、`dotnet test` がプロジェクトをビルドし、アセンブリをテストホストに渡します。ホストはフレームワークの*アダプター*（`xunit.runner.visualstudio`、`NUnit3TestAdapter`、`MSTest.TestAdapter`）を読み込み、アダプターがテストを検出・実行します。

**Microsoft.Testing.Platform** では、テストプロジェクト自身がランナーです。独自のコマンドラインを持つ実行可能なモジュールとしてビルドされます。

- `--list-tests` で列挙
- `--filter-uid` で選択
- `--report-trx` でレポート出力
- `--coverage` でコードカバレッジ収集

TRX やカバレッジは**拡張機能**です。モジュールが参照・登録する NuGet パッケージであり、プラットフォームに常備されたフラグではありません。この違いが、以降の挙動の多くを説明します。

## オプトイン方法：C# と F#

.NET 10 SDK では、`dotnet test` が `global.json` から実行モードを選びます。

```json
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

SharpLsp もまずこの設定を読みます。`global.json` がないプロジェクトも検出します。MSBuild に Testing Platform アプリケーションかどうかを問い合わせるため、VSTest のリポジトリにある MTP プロジェクトのテストも表示されます。

MTP を使う **C# xUnit v3** テストプロジェクトの例です。

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit.v3" Version="4.0.0" />
    <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.4.0" />
  </ItemGroup>
</Project>
```

**F# xUnit v3** テストプロジェクトでは、同じプロジェクト設定に F# 固有のコンパイル順序を加えます。

```xml
<ItemGroup>
  <Compile Include="Tests.fs" />
</ItemGroup>
```

```fsharp
module MyApp.Tests.Calculator

open Xunit

[<Fact>]
let ``adds two numbers`` () = Assert.Equal(3, 1 + 2)

[<Theory>]
[<InlineData(1, 2, 3)>]
[<InlineData(2, 2, 4)>]
let ``adds rows`` (a: int) (b: int) (expected: int) = Assert.Equal(expected, a + b)
```

MTP の **MSTest** では `MSTest` 4.x を参照し、`<EnableMSTestRunner>true</EnableMSTestRunner>` を設定します。**NUnit** では `NUnit` と `NUnit3TestAdapter` 6.x を参照し、`<EnableNUnitRunner>true</EnableNUnitRunner>` を設定します。いずれもモジュール自身が実行ファイルなので `<OutputType>Exe</OutputType>` が必要です。

xUnit v3 と NUnit では **`Microsoft.Testing.Extensions.TrxReport` を参照してください**（MSTest には既に含まれます）。これがないとモジュールは `--report-trx` を拒否し、テストごとの結果を報告できません。その場合、Test Explorer は「No result reported」を並べる代わりに、追加すべきパッケージ名を示します。

## Test Explorer が MTP モジュールに対して行うこと

**検出。** SharpLsp は検出対象をビルドしてから、`dotnet exec <module> --list-tests json` で各モジュールに直接問い合わせます。`dotnet test` は `json` 引数を転送しないため、経由しません（[dotnet/sdk#49754](https://github.com/dotnet/sdk/issues/49754)）。転送されるテキスト形式には表示名しかなく、MSTest では単なるメソッド名になります。

JSON の一覧には各テストの名前空間、型、メソッド、**ソース位置**が含まれるため、MTP のテスト行から記述された行に移動できます。ツリーは VSTest と同じ **Assembly → Namespace → Class → Test** です。

Testing Platform 2.3 より古いモジュールは JSON で列挙できません。その場合は、フレームワークパッケージの更新を促すメッセージをログとツリーに表示します。

**実行（▶）。** 選択全体につきモジュールごとに 1 回だけ起動し、テストごとには起動しません。20 テストあるクラスでもプロセス起動は 20 回になりません。選択内容は `--filter-uid` 値で渡します。これは**対応するすべての MTP フレームワークが受け付ける `dotnet test` のフィルター**であり、エスケープなしのリテラル値を使えます。NUnit の `Adds_Case(2,2,4)` のような uid で重要です。

結果は `--report-trx` から取得し、VSTest と同じ TRX リーダーで読み取ります。成功、失敗、スキップは実際の結果で、アサーション文もフレームワーク自身のものです。データ駆動テスト（xUnit の `[Theory]`、MSTest の `[DataRow]`、NUnit の `[TestCase]`）はツリーでは 1 行となり、**最も悪い**データ行の結果で判定されます。

**コードカバレッジ。** モジュールが `Microsoft.Testing.Extensions.CodeCoverage` を参照している場合、Run with Coverage は `--coverage --coverage-output-format cobertura` を渡します。MTP は結果ディレクトリ直下に `<guid>.cobertura.xml` を書きます。coverlet の `coverage.cobertura.xml` は 1 階層下です。リーダーは各収集器が実際に書く深さを参照します。

MTP で「dotnet test code coverage」を探しているなら、答えはそのパッケージと 2 つのフラグです。パッケージのないモジュールには、その名前を示すメッセージが出ます。

**デバッグ。** Debug プロファイルは `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` でモジュールを起動します。モジュールは pid を出力して待機し、SharpLsp は netcoredbg ベースのデバッガーをそのプロセスに接続します。テスト本体のブレークポイントで停止し、Just My Code、ローカル変数、ウォッチが機能します。デバッグ実行がツリーに架空の結果を書き込むことはありません。

**VSTest と MTP の併用。** ランナーはワークスペース単位ではなく、検出対象ごとに選ばれます。VSTest フォルダーと MTP フォルダーを持つマルチルートワークスペースでは、各テストが検出元のランナーに送られます。MTP モジュールは実行前にそれぞれのフォルダーから再ビルドされます。

## F# も第一級の対応

SharpLsp は [F# を第一級の言語として扱います](/ja/blog/why-fsharp-is-first-class-in-sharplsp/)。そのため、MTP の各ケースを C# だけでなく F# でも確認しています。

- **空白を含むバッククォート名**（例：``` ``adds two numbers`` ```）は、ツリー、フィルター、デバッガーまで元の形で届きます。
- **F# モジュール**は CLR 型にコンパイルされるため、`MyApp.Tests.Calculator` は C# クラスと同様に名前空間 `MyApp.Tests` → クラス `Calculator` と表示されます。
- **F# の `[<Theory>]` 行**は、1 つの id の下で別々の uid を持ちます。デバッグすると各 `[<InlineData>]` の引数で行ごとに停止します。
- **空白と括弧のある NUnit `[<TestCase>]` バインディング**では、NUnit 自身が `--filter-uid` をフィルター式に変換して拒否することがあります。SharpLsp は拒否を検出し、モジュールをフィルターなしで 1 回実行してレポートから名前で結果を選びます。
- **複数ターゲットの F# モジュール**（`<TargetFrameworks>net9.0;net10.0</TargetFrameworks>`）の `#if NET9_0` ブロックは、1 つのツリールートの下に全フレームワークの結果を報告します。TRX レポートはモジュールごとに 1 つです。
- **F# プロジェクトを VSTest から MTP に移行**しても、テスト id とツリーは維持されます。次の更新時に `global.json` の設定を検出し、次の ▶ は MTP で実行されます。
- **カーソル位置のテストをデバッグ**すると、Testing ビューと同じく、待機中の F# モジュールに接続されます。

## 信頼性のために修正した不具合

デモプロジェクトで MTP を「動かす」ことは簡単です。実際のプロジェクトで正しい結果を出すのは別の話です。レビューと強化の過程で実際の不具合が見つかり、それぞれ失敗するエンドツーエンドテストを先に書いてから根本原因を修正しました。

- **古いモジュール。** `dotnet exec` 自体はビルドしません。編集直後のテストが編集前の状態で動いていました。現在は MTP の実行前に対象を再ビルドします。
- **TRX の衝突。** 1 プロジェクトの 2 つのターゲットフレームワークで同名のモジュールができ、レポートが上書きされていました。現在は呼び出しごとに番号を付けます。
- **モジュールの失敗の消失。** 失敗したモジュールのメッセージが、別モジュールの結果で消えることがありました。現在は各モジュールの失敗を保持します。
- **更新の後に並んだ実行が古いランナーを使用。** MTP に切り替えたばかりのプロジェクトで検出更新が待機している間に ▶ を押すと、MTP が拒否する `dotnet test --filter … --logger trx` に送られていました。現在は検出結果をそのキュージョブ内で適用し、後続の実行が見つかったランナーを使います。
- **TRX 拡張機能を付けたデバッグ。** `Microsoft.Testing.Extensions.TrxReport` のホストコントローラーは同じ環境でテストホストを再起動します。`TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` の下では両方がデバッガーを待っていました。デバッグ実行では `--report-trx` を省きます。
- **編集した Theory 行が誤って成功。** 最新の修正です。`--filter-uid` はモジュール固有のキーで、フレームワークごとに生成方法が異なります。
  - **xUnit v3** は Theory 行のデータを uid にハッシュします。
  - **MSTest** はデータ行の位置をキーにします。

  行の追加や xUnit 行のデータ編集で、検出時にはなかった uid が生まれます。古い uid で再ビルド後のモジュールを絞ると、**変更した行だけ**が実行から漏れ、赤にした行が**緑**と報告されていました。SharpLsp は絞り込み実行前に再ビルドしたモジュールを再列挙し、そのビルドで実際に存在する uid を選びます。

## MTP 上の xUnit、MSTest、NUnit

新しいプロジェクトで **xUnit と MSTest**、または **NUnit と xUnit** を比較するなら、エディターから見た Microsoft.Testing.Platform 上の違いは次のとおりです。

| | xUnit v3 | MSTest | NUnit |
|---|---|---|---|
| VSTest アダプター | 4.0 以降なし（MTP 専用） | あり | あり |
| TRX レポート | `Microsoft.Testing.Extensions.TrxReport` を追加 | 組み込み | `Microsoft.Testing.Extensions.TrxReport` を追加 |
| `--list-tests json` のソース位置 | あり | あり | なし |
| データ行の uid | 行データのハッシュ | 行の位置 | 修飾された名前（例：`Adds_Case(2,2,4)`） |
| 表示名 | 完全修飾名 | 単純なメソッド名 | 引数付きのメソッド名 |

これだけで特定のフレームワークを選ぶべきではありません。Test Explorer が表示名からテスト id を作ってはいけないこと、昨日の uid を信じてはいけないことを示しています。

## 実際のプロジェクトで検証

MTP 対応には、実際の VS Code 拡張ホスト内で本物の `.csproj` と `.fsproj` をビルドするエンドツーエンドテストがあります。

- C# と F# それぞれの xUnit v3、MSTest、NUnit
- 複数ターゲットのモジュール
- TRX またはカバレッジ拡張機能のないモジュール
- 1 つのコマンドラインに収まらない長い選択
- VSTest と MTP の混在ワークスペース
- 更新処理の後に並んだ実行
- C# と F# の実際のブレークポイントを使うデバッグ
- 検出と ▶ の間に編集・追加したデータ行

Windows と Linux の CI で、VSTest のスイートと並んで専用のジョブとして実行されます。

## FAQ

**Microsoft.Testing.Platform で `dotnet test` を使うには？** .NET 10 SDK では `global.json` に `"test": { "runner": "Microsoft.Testing.Platform" }` を追加し、MTP 対応のフレームワークパッケージを使います（xUnit v3、`EnableMSTestRunner` を設定した MSTest、または `EnableNUnitRunner` を設定した NUnit）。

**xUnit v3 は VSTest で動きますか？** 4.0 以降は動きません。`xunit.v3` 4.x は MTP v2 専用で、VSTest アダプターはありません。

**MTP でテストを絞り込むには？** フレームワークごとに固有のフィルターがあります。`--filter-uid` はプラットフォーム自身のフィルターで、SharpLsp の ▶ でも使います。選択したテストだけを正確に実行できます。

**MTP の `dotnet test` でコードカバレッジを取るには？** `Microsoft.Testing.Extensions.CodeCoverage` を参照し、`--coverage --coverage-output-format cobertura` を渡します。SharpLsp Test Explorer の Run with Coverage が代わりに実行します。

**1 つのリポジトリで VSTest と MTP を混在させられますか？** はい。SharpLsp は検出対象ごとにランナーを選び、検出元のランナーへ各テストを送ります。

## 試してみる

MTP 対応は SharpLsp 0.21.0 の次のリリースで提供予定です。[リリースページ](https://github.com/Nimblesite/SharpLsp/releases)を確認するか、現在の `main` から VS Code 拡張機能をビルドしてください。Microsoft.Testing.Platform を使う xUnit v3、MSTest、NUnit プロジェクトを含むソリューションを開き、Testing ビューを表示します。ツリーが空、結果が違う、デバッガーが接続されないなどの問題があれば、[issue を作成してください](https://github.com/Nimblesite/SharpLsp/issues)。この機能もそこから始まりました。
