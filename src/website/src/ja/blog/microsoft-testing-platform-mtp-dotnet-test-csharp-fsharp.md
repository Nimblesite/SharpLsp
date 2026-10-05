---
layout: layouts/blog.njk
title: "Test Explorer の Microsoft.Testing.Platform（MTP）：C# と F# の dotnet test、xUnit v3、MSTest、NUnit"
description: "SharpLsp の VS Code Test Explorer が Microsoft.Testing.Platform のテスト検出、実行、デバッグ、カバレッジに対応。C# と F# の xUnit v3、MSTest、NUnit を VSTest と併用できます。"
lang: ja
date: 2026-09-22
author: SharpLsp チーム
image: /assets/images/blog/microsoft-testing-platform-mtp-dotnet-test-csharp-fsharp.png
imageAlt: C# と F# の xUnit v3、MSTest、NUnit テストを SharpLsp Test Explorer に一覧表示する dotnet test モジュール
tags:
  - posts
  - testing
  - csharp
  - fsharp
  - dotnet-lsp
category: testing
excerpt: "xUnit v3 4.0 は Microsoft.Testing.Platform 専用です。SharpLsp は C# と F# の MTP と VSTest を同時に扱い、検出、実行、デバッグ、コードカバレッジに対応します。"
---

.NET 開発者が使う `dotnet test` が変わりつつあります。**Microsoft.Testing.Platform（MTP）** は **VSTest** に代わる新しいテスト基盤です。テストプロジェクト自体が、検出と実行を担当する実行可能な *テストモジュール* になります。別の `testhost` プロセスや、その間に入るアダプターはありません。MSTest、NUnit、xUnit はいずれも MTP ランナーを提供し、**xUnit v3 4.0 は MTP v2 のみに対応**しています。VSTest アダプターは含まれません。

そのため、VSTest にしか対応しないエディターの Test Explorer は、新しい xUnit v3 プロジェクトで **空のツリー** を表示します。テストは存在し、`dotnet test` で実行できるのに、エディターには見えません。

SharpLsp の Test Explorer は両方に対応しました。実装は現在 `main` にあり、次のリリースに含まれます。**C# と F# の xUnit v3、MSTest、NUnit** の MTP モジュールを検出、実行、デバッグし、カバレッジを収集できます。VSTest プロジェクトとの併用も、両方を含むマルチルートワークスペースも可能です。この記事では次を説明します。

- Microsoft.Testing.Platform 上での `dotnet test` の動作
- C# または F# プロジェクトでの有効化
- Test Explorer の動作
- 信頼性を確保する過程で見つかった実際のバグ

## Valentin Dide さん、ありがとうございます

この機能のきっかけは、まさにその空のツリーに遭遇した **[Valentin Dide（@validide）](https://github.com/validide)** さんです。[issue #249「Microsoft.Testing.Platform (MTP) support in Test Explorer」](https://github.com/Nimblesite/SharpLsp/issues/249)を報告し、実装にも取り組んでくれました。[PR #250「Microsoft.Testing.Platform support in the Test Explorer」](https://github.com/Nimblesite/SharpLsp/pull/250)で追加されたのは次の機能です。

- MTP の判定
- `--list-tests json` による検出
- `--filter-uid` による実行
- TRX の結果読み取り
- MTP モジュール用の Debug プロファイル
- 両言語の全フレームワークを網羅する六つの実プロジェクトによるテスト

この記事の内容はすべて、その PR を土台にしています。Valentin さん、ありがとうございます。こうした協力がオープンソースの .NET ツールを支えています。

## MTP と VSTest の違い

**VSTest** では、`dotnet test` がプロジェクトをビルドし、アセンブリをテストホストに渡します。ホストはフレームワークの *アダプター*（`xunit.runner.visualstudio`、`NUnit3TestAdapter`、`MSTest.TestAdapter`）を読み込み、そのアダプターがテストを検出して実行します。

**Microsoft.Testing.Platform** では、テストプロジェクトそのものがランナーです。独自のコマンドラインを持つ実行可能モジュールになります。

- `--list-tests`：列挙
- `--filter-uid`：選択
- `--report-trx`：レポート出力
- `--coverage`：カバレッジ収集

TRX やカバレッジは **拡張機能** です。モジュールが参照して登録する NuGet パッケージであり、常に使用できるプラットフォーム標準のフラグではありません。この違いが、以下の動作を理解する鍵になります。

## C# と F# で有効にする

.NET 10 SDK では、`dotnet test` は `global.json` から実行モードを選びます。

```json
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

SharpLsp もまずこの設定を読みます。`global.json` がなくても検出できます。MSBuild に Testing Platform アプリケーションかどうかを問い合わせるため、VSTest のリポジトリ内にある MTP プロジェクトも対象になります。

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

**F# xUnit v3** では、同じ設定に F# で必要なコンパイル順序を追加します。

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

MTP の **MSTest** には `MSTest`（4.x）を参照し、`<EnableMSTestRunner>true</EnableMSTestRunner>` を設定します。**NUnit** には `NUnit` と `NUnit3TestAdapter` 6.x を参照し、`<EnableNUnitRunner>true</EnableNUnitRunner>` を設定します。モジュール自体が実行可能ファイルになるため、三つとも `<OutputType>Exe</OutputType>` が必要です。

xUnit v3 と NUnit には **`Microsoft.Testing.Extensions.TrxReport` を参照してください**。MSTest にはすでに含まれます。この拡張がないと、モジュールは `--report-trx` を拒否し、テスト単位の結果を報告できません。Test Explorer は「結果が報告されませんでした」を並べる代わりに、追加すべきパッケージを示します。

## MTP モジュールを Test Explorer で扱う

**検出。** SharpLsp は検出対象をビルドし、`dotnet exec <module> --list-tests json` で各モジュールに直接問い合わせます。`dotnet test` は `json` 引数を転送しないため、経由しません（[dotnet/sdk#49754](https://github.com/dotnet/sdk/issues/49754)）。転送されるテキスト一覧には表示名しかなく、MSTest ではメソッド名だけになります。

JSON 一覧には名前空間、型、メソッド、**ソース位置** が含まれます。そのため、MTP のテスト行から定義行を開けます。ツリーは VSTest と同じ **Assembly → Namespace → Class → Test** です。

Testing Platform 2.3 より前のモジュールは JSON 一覧に対応しません。その場合、ログとツリーでフレームワークパッケージの更新を案内します。

**実行（▶）。** 選択全体についてモジュールごとに一度実行し、テストごとには起動しません。二十個のテストを持つクラスで二十回プロセスを起動することはありません。選択は `--filter-uid` の値として渡します。これは検証対象の全 MTP フレームワークで使えるフィルターで、エスケープせずにリテラル値を渡します。NUnit の `Adds_Case(2,2,4)` のような uid でも重要な性質です。

結果は `--report-trx` から、VSTest と共通の TRX リーダーで読み取ります。成功、失敗、スキップは実際の結果で、アサーションの文言もフレームワーク自身のものです。xUnit の `[Theory]`、MSTest の `[DataRow]`、NUnit の `[TestCase]` はツリーで一行にまとめ、**最も悪い結果** を表示します。

**コードカバレッジ。** モジュールが `Microsoft.Testing.Extensions.CodeCoverage` を参照する場合、Run with Coverage は `--coverage --coverage-output-format cobertura` を渡します。MTP は結果ディレクトリの直下に `<guid>.cobertura.xml` を書きます。coverlet の `coverage.cobertura.xml` のように一階層下ではないため、リーダーは各コレクターの実際の出力先を調べます。

MTP で `dotnet test` のコードカバレッジを使うには、このパッケージとフラグの組み合わせが必要です。パッケージがないモジュールには、その名前を含む案内を表示します。

**デバッグ。** Debug プロファイルは `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` を設定してモジュールを起動します。モジュールは PID を出力して待機します。SharpLsp はそのプロセスに netcoredbg ベースのデバッガーをアタッチし、テスト内のブレークポイントで停止します。Just My Code、ローカル変数、ウォッチが動作し、デバッグ実行で架空の結果をツリーへ書き込むことはありません。

**VSTest と MTP の併用。** ランナーはワークスペース単位ではなく検出対象ごとに選びます。両方のフォルダーを含むマルチルートワークスペースでも、各テストを検出したランナーへ送ります。MTP モジュールは実行前に自身のフォルダーで再ビルドされます。

## F# も同じように検証する

SharpLsp は [F# を第一級市民として扱う](/ja/blog/why-fsharp-is-first-class-in-sharplsp/)ため、MTP の各ケースを C# と F# の両方で検証します。

- ``` ``adds two numbers`` ``` のような **空白を含むバッククォート名** は、ツリー、フィルター、デバッガーへそのまま渡されます。
- **F# モジュール** は CLR 型になるため、`MyApp.Tests.Calculator` は名前空間 `MyApp.Tests` → クラス `Calculator` と表示されます。
- **F# の `[<Theory>]` 行** は、一つの ID の下に別々の uid を持ちます。デバッグでは各行の `[<InlineData>]` 引数で一度ずつ停止します。
- 空白と括弧を含む **NUnit の `[<TestCase>]` バインディング** では、NUnit 自身の `--filter-uid` 変換が拒否されます。SharpLsp はそれを検出し、フィルターなしでモジュールを一度再実行して、名前で結果を取り出します。
- **複数ターゲットの F# モジュール**（`<TargetFrameworks>net9.0;net10.0</TargetFrameworks>`）と `#if NET9_0` では、各モジュールに一つの TRX を作り、全フレームワークの結果を一つのツリールートに表示します。
- **F# プロジェクトを VSTest から MTP へ移行**しても、テスト ID とツリーを保ちます。次の更新で `global.json` を読み、次の ▶ は MTP を使います。
- `.fs` ファイルのカーソル位置での **Debug Test** も、Testing ビューと同様に待機中の F# モジュールへアタッチします。

## 信頼性を確保する過程で見つかったバグ

デモで動くだけでなく、実際のプロジェクトで正しく動くことが必要です。調査で見つかった次の不具合は、それぞれ先に失敗するエンドツーエンドテストを書いて修正しました。

- **古いモジュールの実行。** `dotnet exec` はビルドしないため、編集前のテストを実行していました。今は MTP の実行前に対象を再ビルドします。
- **TRX の衝突。** 一つのプロジェクトの二つのターゲットフレームワークが同名のモジュールを作り、レポートを上書きしていました。今は呼び出しごとに番号を付けます。
- **モジュールの失敗情報の消失。** 別モジュールの結果でエラーが消える場合がありました。今は各モジュールの失敗を保持します。
- **更新待ちの実行が古いランナーを使用。** MTP へ移行した直後の検出待ちで ▶ を押すと、MTP が拒否する `dotnet test --filter … --logger trx` を使っていました。検出結果をそのキュー内で適用し、後続の実行が新しいランナーを使うようにしました。
- **TRX 拡張付きのデバッグ。** `Microsoft.Testing.Extensions.TrxReport` は同じ環境でテストホストを再起動するコントローラーを使います。`TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` で両方が待機してしまうため、デバッグでは `--report-trx` を省きます。
- **編集したデータ行で誤った成功。** `--filter-uid` はモジュール固有のキーで、生成方法が異なります。
  - **xUnit v3 は行データのハッシュ**を uid に使います。
  - **MSTest は行の位置**をキーに使います。

  行の追加や xUnit のデータ変更で、検出時にはなかった uid ができます。古い uid で再ビルド後のモジュールを絞ると、変更した行だけを実行せず、失敗するはずのテストが成功扱いになりました。今はフィルター付き実行前に再列挙し、そのビルドの uid を選びます。

## MTP での xUnit、MSTest、NUnit の比較

新しいプロジェクトで **xUnit と MSTest**、または **NUnit と xUnit** を比較する際、エディターから見た MTP の違いは次のとおりです。

| | xUnit v3 | MSTest | NUnit |
|---|---|---|---|
| VSTest アダプター | 4.0 以降はなし（MTP のみ） | あり | あり |
| TRX レポート | `Microsoft.Testing.Extensions.TrxReport` を追加 | 組み込み | `Microsoft.Testing.Extensions.TrxReport` を追加 |
| `--list-tests json` のソース位置 | あり | あり | なし |
| データ行の uid | 行データのハッシュ | 行の位置 | `Adds_Case(2,2,4)` などの修飾された名前 |
| 表示名 | 完全修飾名 | メソッド名のみ | 引数付きのメソッド名 |

これらは特定のフレームワークを選ぶ理由ではありません。Test Explorer が表示名から ID を作ったり、以前の uid を信用したりしてはいけない理由です。

## 実プロジェクトで検証

MTP 対応は、実際の VS Code 拡張ホスト内で本物の `.csproj` と `.fsproj` をビルドするテストで検証しています。

- C# と F# の xUnit v3、MSTest、NUnit
- 複数ターゲットのモジュール
- TRX またはカバレッジ拡張がないモジュール
- 一つのコマンドラインには長すぎる選択
- VSTest と MTP が混在するワークスペース
- 更新待ちの実行
- C# と F# の実際のブレークポイントによるデバッグ
- 検出と ▶ の間で変更、追加されたデータ行

CI では Windows と Linux の専用ジョブで、VSTest のテストと並行して実行します。

## よくある質問

**Microsoft.Testing.Platform で `dotnet test` を実行するには？** .NET 10 SDK で、`global.json` に `"test": { "runner": "Microsoft.Testing.Platform" }` を追加し、MTP 対応パッケージを使います。xUnit v3、`EnableMSTestRunner` を設定した MSTest、`EnableNUnitRunner` を設定した NUnit が対象です。

**xUnit v3 は VSTest で動きますか？** 4.0 以降は動きません。`xunit.v3` 4.x は MTP v2 のみで、VSTest アダプターを含みません。

**MTP でテストを絞り込むには？** フレームワークごとのオプションに加え、プラットフォーム自身の `--filter-uid` があります。SharpLsp は ▶ でこれを使い、選んだテストを実行します。

**MTP の `dotnet test` でカバレッジを取得するには？** `Microsoft.Testing.Extensions.CodeCoverage` を参照し、`--coverage --coverage-output-format cobertura` を渡します。SharpLsp の Run with Coverage がこの操作を行います。

**一つのリポジトリで VSTest と MTP を混在できますか？** できます。SharpLsp は検出対象ごとにランナーを選び、各テストを検出したランナーへ送ります。

## 試してみる

MTP 対応は 0.21.0 の次の SharpLsp リリースに含まれます。[リリースページ](https://github.com/Nimblesite/SharpLsp/releases)を確認するか、現在の `main` から VS Code 拡張をビルドしてください。MTP を使う xUnit v3、MSTest、NUnit のソリューションを開き、Testing ビューを表示します。空のツリー、誤った結果、アタッチできないデバッガーがあれば、[issue を報告してください](https://github.com/Nimblesite/SharpLsp/issues)。この機能も、そこから始まりました。
