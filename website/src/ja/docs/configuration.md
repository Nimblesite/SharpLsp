---
layout: layouts/docs.njk
title: 設定
lang: ja
eleventyNavigation:
  key: 設定（日本語）
  order: 9
---

# 設定

![SharpLsp のワークスペース設定を VS Code で表示](/assets/screenshots/vscode-configuration-page.png)

SharpLsp は、ワークスペースのルート（`.sln` またはルート `.csproj` と同じ場所）に置いた `sharplsp.toml` で設定します。すべての設定には妥当な既定値があり、このファイルは省略できます。

`sharplsp.toml` は `deny_unknown_fields` を使います。下記にないキーがあると、起動時にパースエラーになります。

## sharplsp.toml リファレンス

```toml
# sharplsp.toml — 完全な設定リファレンス
# 表示されているキーはすべて任意です。省略時は既定値が使われます。

# ─── Server ────────────────────────────────────────────────────────────────────
[server]
# ログレベル: "trace", "debug", "info", "warn", "error"
log_level = "info"

# キー入力後のセマンティックリクエスト用 debounce 時間（ミリ秒）
debounce_ms = 150

# ─── C# ────────────────────────────────────────────────────────────────────────
[csharp]
# C# サイドカーを有効化
enabled = true

# 読み込む .sln ファイルのパス。空 = 自動検出
solution_path = ""

# ─── F# ────────────────────────────────────────────────────────────────────────
[fsharp]
# F# サイドカーを有効化
enabled = true

# ─── Diagnostics ───────────────────────────────────────────────────────────────
[diagnostics]
# Roslyn アナライザーを実行（コンパイラーエラーだけではない）
analyzers_enabled = true

# 開いているファイルだけでなく、ソリューション内の全ファイルを解析
solution_wide_analysis = true

# 対象にするプロジェクト名パターン（空 = すべてのプロジェクト）
project_filter = []

# ─── Profiler ──────────────────────────────────────────────────────────────────
[profiler]
# 同時実行できるプロファイルセッション数
max_concurrent_sessions = 5

# 既定のトレース時間（秒、0 = 無制限）
default_trace_duration = 30

# 既定のトレース出力形式 ("speedscope", "chromium", "nettrace")
default_trace_format = "speedscope"

# 既定のカウンタープロバイダー
default_counter_providers = ["System.Runtime"]

# 既定のカウンター更新間隔（秒）
default_counter_interval = 1

# トレース / ダンプファイルの出力ディレクトリ
output_directory = ".sharplsp/profiles"
```

## ファイルの場所

SharpLsp はワークスペースルートから親ディレクトリへたどり、最初に見つかった `sharplsp.toml` を使います。見つからない場合は、すべて既定値が適用されます。

```
my-solution/
├── sharplsp.toml          ← ここに置く
├── MyApp.sln
├── MyApp.Core/
│   └── MyApp.Core.csproj
└── MyApp.Api/
    └── MyApp.Api.csproj
```

## プロジェクトごとの上書き

Roslyn は `.editorconfig` の重要度設定をアナライザーの重要度へ直接マップします。

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.IDE0003.severity = warning   # 'this' 修飾を削除
dotnet_diagnostic.CA1054.severity = error       # URI パラメーターは string にすべきではない
```

## 言語を無効化する

サイドカーをまったく起動しない場合は、その言語の `enabled` フラグを `false` にします。

```toml
[fsharp]
enabled = false
```

その言語へのリクエストは拒否され、サイドカープロセスは生成されません。
