---
layout: layouts/blog.njk
title: "SharpLsp 0.19.0: 信頼できる実行・デバッグ・テストのループ"
description: "SharpLsp 0.19.0 は VS Code の実行/デバッグ体験を根本原因から修正します。launch profile の検出、複数プロファイル選択プロンプト、キャンセル可能なビルドに加え、新しい DapRouter による論理的な非同期コールスタック、4,800 行のエンドツーエンドテストで堅牢になった Test Explorer を提供します。"
lang: ja
date: 2026-08-30
author: SharpLsp チーム
image: /assets/images/blog/sharplsp-0-19-run-debug-test-explorer.png
imageAlt: launch profile の選択プロンプト、再構成された非同期スタックトレース、成功したテスト結果を示すターミナル
tags:
  - posts
  - announcement
  - csharp
  - fsharp
  - dotnet-lsp
category: announcement
excerpt: "0.19.0 はインナーループを本当に修正します。dotnet run と同じ挙動の F5 と launch profile、MoveNext の羅列ではなくコードそのままの非同期スタック、4,800 行の e2e テストに支えられた Test Explorer。"
---

バージョン 0.19.0 のテーマはインナーループです。F5 を押し、launch profile を選び、ブレークポイントで止まり、スタックを読み、テストを実行する。この一連のループが完全に動作するようになりました。さらに重要なのは、それを証明できることです。すべてのピースが、実際のプロジェクトをビルドし実際の結果を検証するエンドツーエンドテストでカバーされています。

このリリースは 5 プラットフォームすべての VSIX パッケージ —— win32-x64/arm64、linux-x64/arm64、darwin-arm64 —— を SHA256 チェックサム付きで[リリースページ](https://github.com/Nimblesite/SharpLsp/releases/tag/v0.19.0)から提供しています。以下、変更内容です。

## F5 と Launch Profile を本当の意味で修正

以前の実行/デバッグ体験には、UI の磨きでは隠せないバグがありました。`dotnet run` では見えるのに拡張機能からは見えないプロファイル、プロファイルが複数あるプロジェクトでのサイレントな失敗、キャンセルできないビルド。この 3 つすべてを根本原因から修正しました。

- **launch profile の検出**。拡張機能は `dotnet run` と同じ MSBuild 評価を通して launch profile を解決するようになり、`TargetPath` 評価のせいで有効なプロファイルが隠れていたケースも含めて対応しました。`dotnet run --launch-profile X` でアプリが起動するなら、F5 でプロファイル X を選んでも起動します。
- **複数プロファイル時のプロンプト**。launch profile を 2 つ以上持つプロジェクトでは、サイレントに 1 つを選んだり起動に失敗したりする代わりに、選択を促すプロンプトが表示されます。
- **キャンセル可能なビルド**。`applyTarget` は実際のビルドを開始し、キャンセルを尊重します。以前は事実上 fire-and-forget で、デバッガーがまだバイナリを書き出しているビルドと競合する可能性がありました。

実行/デバッグのエンドツーエンドチャンクは 21/21 でグリーンです。これらのスイートは実際のプロジェクトファイルを起動し、アタッチし、動作を検証します。デバッガーをモックしていません。

## コードのように読める非同期スタック

非同期 C# のデバッグは、常にステートマシンの内部を読み解く作業でした。実際に書いた `await` チェーンではなく、`MoveNext` フレームの壁です。このリリースでは **DapRouter**（`dap-router.ts` + `dap-frames.ts`）を導入しました。Debug Adapter Protocol のルーティング層であり、エディタに届く前に**論理的な非同期コールスタックを再構成**します。

ルーターがあれば、await 中の呼び出しで一時停止すると、期待どおりのチェーンが表示されます。

```
ProcessOrders()
  await ChargeCardAsync()
    await Gateway.PostAsync()   ← paused here
```

コンパイラーが生成した配管が 3 段積み重なったものではありません。

DapRouter は DAP 1.71 を話し、次の段階の基盤でもあります。netcoredbg と ICorDebug パスはこの背後で交換可能になり、ロードマップ上の機能 —— logpoints、`DebuggerDisplay` エミュレーション、hot reload 調整 —— は同じ配管の上に構築されます。

## エンドツーエンドで証明された Test Explorer

Test Explorer は静かに腐ります。デモプロジェクトでは discovery が動くのに、あなたのプロジェクトでは失敗する。バージョン 0.19.0 は** 7 つの新しいエンドツーエンドスイート —— 約 4,800 行のテスト** —— を追加しました。カバーするのは次のとおりです。

- **Frameworks** —— 対応するテストフレームワーク全体での discovery と実行
- **Outcomes** —— passed、failed、skipped の正確な報告
- **Parsers** —— テスト出力を単なるテキストではなく実際の結果へパース
- **Reactivity** —— 結果が届くにつれてツリーが更新されること
- **Windows** —— 挙動が異なるプラットフォームでの動作
- **Kit** —— 他のスイートが依存するヘルパー群

outcome アサーションは、表示されたものではなく実際に実行されたものを検証します。そしてこの動作は `TEST-EXPLORER-SPEC.md` に明文化され、口伝ではなく文書化された契約になりました。

## 静かに腐らないエディタ拡張

このリリースで最も価値のある修正は、あなたには決して見えないものかもしれません。0.19.0 のサイクル中に、SharpLsp 自身の Zed 拡張機能が、実行されたことのないテストスイートを同梱していたことが判明しました。その一部は、定数が自分自身と等しいと主張する同語反復でした。中身のないグリーンのパイプラインです。これはまさに、この記事で扱ってきたようなリリースを生み出す失敗モードそのものであり、構造的に修正しました。

- **Zed**: 31/31 テストがパスし、85.04% の行カバレッジが CI でゲートされます。同語反復テストは削除され、バージョンパリティテストは `extension.toml` を実際にパースし、パイプラインロジックは直接テストできる `pipeline.rs` に抽出されました。
- **Rider**: これまで*テストゼロ・CI ゼロ*だった 2,961 行の Kotlin プラグインに、最初の 8 つのテスト（NuGet ステートのマージ、大文字小文字を無視したパッケージ ID マッチング、ソート順、pending フラグ）が入り、新しい `ci-editors.yml` パイプラインで毎 PR コンパイルされます。
- **サイレントな空は許さない**: エディタレグ全体で `failOnNoDiscoveredTests = true`。何も discovery しなかったテストタスクが、二度と成功を報告することはありません。

## ビルドとリリースの堅牢化

残りの作業は、リリース自体を誠実に保つ見えない配管です。

- **VSIX ペイロード検証**（`verify-vsix-payload.mjs`）は、公開されるものがビルドしたものと一致することを検証します。サイドカーの欠落も、古いアーティファクトもありません。
- **netcoredbg フェッチの修正**により、ビルド中のデバッガーバイナリ解決が安定しました。
- Rust ホストは `semantic_tokens` の clippy 修正を受け、ウェブサイトには Mermaid レンダリングテストが追加されました。
- .NET スイート全体 —— 983 テスト —— がこのリリースで CI をパスしました。

## 0.19.0 の入手

[リリースページ](https://github.com/Nimblesite/SharpLsp/releases/tag/v0.19.0)からインストールしてください（プラットフォーム用 VSIX と SHA256 チェックサム付き）。[ドキュメント](https://sharplsp.dev/docs/)も参照してください。インナーループがあなたのプロジェクトで壊れるものがあれば —— [それこそ私たちが欲しい issue です](https://github.com/Nimblesite/SharpLsp/issues)。
