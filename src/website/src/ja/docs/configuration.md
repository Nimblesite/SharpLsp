---
layout: layouts/docs.njk
title: 設定
lang: ja
eleventyNavigation:
  key: 設定（日本語）
  order: 9
---

# 設定

![VS Code での SharpLsp ワークスペース設定](/assets/screenshots/vscode-configuration-page.png)

SharpLsp には 2 つの設定方法があります。

- `sharplsp.toml` に記述するワークスペース単位のサーバー設定
- VS Code の `sharplsp.*` 以下にあるクライアントおよび UI 設定

これらを相互に置き換えることはできません。特に、FSI の引数とインレイヒントの表示設定は VS Code の設定であり、TOML フィールドではありません。

## sharplsp.toml の場所

`sharplsp.toml` はソリューションまたはプロジェクトと同じ場所に置きます。SharpLsp はワークスペースルートから開始して上位ディレクトリへたどり、最初に見つかったファイルを使用します。単一ファイルモードでは、サーバーの現在のディレクトリから開始します。

スキーマは `deny_unknown_fields` を使用します。キーのスペルが誤っている場合やサポートされていない場合は、起動エラーになります。

## 完全な TOML スキーマ

```toml
[server]
log_level = "info"
debounce_ms = 150

[csharp]
enabled = true
solution_path = ""

[fsharp]
enabled = true

[diagnostics]
analyzers_enabled = true
solution_wide_analysis = true
project_filter = []

[analyzers]
dead_code = true
monorepo = false

[profiler]
max_concurrent_sessions = 5
default_trace_duration = 30
default_trace_format = "speedscope"
default_counter_providers = ["System.Runtime"]
default_counter_interval = 1
output_directory = ".sharplsp/profiles"
```

すべてのフィールドは任意です。省略したフィールドには、上記の値が使われます。

## 実行時の動作に影響する設定

| フィールド | 動作 |
|---|---|
| `csharp.enabled` | C# サイドカーを起動するかスキップします |
| `csharp.solution_path` | ワークスペースからの絶対パスまたは相対パスで `.sln` または `.slnx` を選択します |
| `fsharp.enabled` | F# サイドカーを起動するかスキップします |
| `diagnostics.solution_wide_analysis` | C# の起動時ソリューションスキャンを有効にします |
| `diagnostics.project_filter` | C# スキャンを一致するプロジェクト名に限定します |
| `analyzers.dead_code` | SharpLsp の C# および F# デッドコードアナライザーを有効にします |
| `analyzers.monorepo` | 未使用の public シンボルをデッドコードとして扱い、エラーとして報告します |
| `profiler.max_concurrent_sessions` | 同時に実行できるプロファイラーセッション数を制限します |

`solution_path` が空の場合、SharpLsp はワークスペース探索を使用します。複数のソリューションを含むワークスペースは曖昧であり、1 つを選択するまでは何も読み込まれない場合があります。設定したパスがファイルを指していない場合、サーバーは警告をログに記録し、ワークスペース探索へフォールバックします。

言語を無効にすると、そのサイドカーは起動しません。C# では構文のみを扱うホスト側の動作が残る場合がありますが、無効にした言語へのセマンティックリクエストから有用な結果は返りません。

## 受け付けられるが未適用の設定

次のフィールドは互換性のために解析および保持されますが、値を変更しても現在は該当する動作が変わりません。

- `server.log_level`
- `server.debounce_ms`
- `diagnostics.analyzers_enabled`
- すべての `profiler.*` 既定値（`max_concurrent_sessions` を除く）

VS Code のログには `sharplsp.logging.level` を使用します。この値は `RUST_LOG` としてホストへ転送されます。現在、プロファイラーコマンドは各リクエストの既定値を使用し、`.sharplsp/profiles` 以下へ書き込みます。

## VS Code の主な設定

| 設定 | 用途 |
|---|---|
| `sharplsp.logging.level` | ホストのログフィルター |
| `sharplsp.lspPath` | 信頼されたワークスペースでのサーバーバイナリの上書き |
| `sharplsp.csharpSidecarPath` / `sharplsp.fsharpSidecarPath` | 信頼されたワークスペースでのサイドカーの上書き |
| `sharplsp.server.extraArgs` | 信頼されたワークスペースでの追加サーバー引数 |
| `sharplsp.fsi.extraArgs` | `dotnet fsi` の後に渡す引数 |
| `sharplsp.inlayHints.parameterNames` | パラメーター名ヒントの設定（現在は解析のみ） |
| `sharplsp.inlayHints.typeInference` | 推論型ヒントの設定（現在は解析のみ） |
| `sharplsp.inlayHints.pipelineTypes` | F# のパイプライン型ヒントの設定（現在は解析のみ） |
| `sharplsp.nuget.includePrerelease` | 検索にプレリリースパッケージを含めます |
| `sharplsp.hotReload.onSave` | 保存時にホットリロードを実行します |
| `sharplsp.testLens.enabled` | テストの CodeLens アクションを表示します |
| `sharplsp.solutionExplorer.autoReveal` | ツリーをアクティブなエディターに追従させます |

メンバーの並べ替え順とデバッグアダプターのパスも、VS Code の Settings UI で設定できます。

3 つのインレイヒント設定は拡張機能に登録され、読み取り可能ですが、現在の本番経路では返されるヒントの絞り込みに使用されていません。そのため、設定を変更してもまだ効果はありません。

## .editorconfig

Roslyn と FCS は、それぞれ通常のワークスペース入力を通じてプロジェクト／コンパイラー設定を読み取ります。SharpLsp は現在、`.editorconfig` に重要度が記載されているだけでは、任意のサードパーティ製アナライザーパッケージを実行しません。実装済みのソースについては、[診断](/ja/docs/diagnostics/)を参照してください。
