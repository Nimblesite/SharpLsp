<p align="center">
  <img src="https://sharplsp.dev/assets/images/marketplace/sharplsp-tour.gif" width="100%" alt="SharpLsp のツアー：Visual Studio と Rider に代わるオープンソース。ソリューションエクスプローラー、NuGet ブラウザー、C# と F#、デバッグ、プロファイリング、テストを VS Code・Cursor・Windsurf で">
</p>

<h1 align="center">SharpLsp</h1>

<p align="center">
  <strong>Visual Studio と Rider に代わるオープンソース。</strong><br>
  C# も F# もフルサポート。NuGet、デバッグ、プロファイリング、テストを、いつものエディターで。
</p>

<p align="center">
  <a href="https://sharplsp.dev/ja/docs/">ドキュメント</a> ·
  <a href="https://sharplsp.dev/ja/blog/">ブログ</a> ·
  <a href="https://github.com/Nimblesite/SharpLsp">GitHub</a> ·
  <a href="https://github.com/Nimblesite/SharpLsp/issues">Issues</a> ·
  <a href="https://sharplsp.dev/">English</a> ·
  <a href="https://sharplsp.dev/zh/">简体中文</a>
</p>

## 🥊 重い IDE はもう要らない。パワーはそのまま。

ソリューションエクスプローラー、プロジェクト参照とパッケージ参照、ビルド、リファクタリング、NuGet、デバッガー、プロファイラー、テストエクスプローラー。IDE のワークフローをまるごと VS Code の中に。**サブスクリプション不要。ライセンスサーバー不要。アカウント不要。ずっと MIT。**

<p align="center">
  <img src="https://sharplsp.dev/assets/images/marketplace/sharplsp-explorer.png" width="100%" alt="SharpLsp のソリューションエクスプローラー：.NET ソリューション、プロジェクト、依存関係、C# シンボルと Roslyn でハイライトされたコード">
</p>

## ⚖️ C# と F#。えこひいきなし。

C# は **Roslyn**、F# は **FSharp.Compiler.Service** で動きます。どちらも補完、ホバー、定義へ移動、参照の検索、名前の変更、コードアクション、セマンティックハイライト、インレイヒント、リアルタイム診断に対応。ソリューションエクスプローラー、テストエクスプローラー、デバッガー、プロファイラーも同じものが使えます。

F# にはさらに **F# Interactive**、`.fsi` シグネチャファイル生成、パイプラインの型ヒント。

## 🐞 デバッグ、プロファイル、テスト。おいしいところ全部。

| | |
| --- | --- |
| 🐞 **デバッグ** | F5、ブレークポイント、ステップ実行、ホットリロード。MIT ライセンスの netcoredbg デバッガーを同梱。 |
| 🔥 **プロファイル** | SpeedScope での CPU トレース、ライブカウンター、メモリダンプ、ヒープ差分、リーク検出、保持グラフ。 |
| 🧪 **テスト** | xUnit・NUnit・MSTest・Expecto・FsCheck のテストエクスプローラーと CodeLens。VSTest と MTP、C# と F# の両方。 |
| 📦 **NuGet** | パッケージの検索、インストール、更新、削除、統合。ターミナル不要。 |

<p align="center">
  <img src="https://sharplsp.dev/assets/images/marketplace/sharplsp-nuget.png" width="100%" alt="SharpLsp の NuGet ブラウザー：ダウンロード数付きのパッケージ一覧と、インストールボタンのあるパッケージ詳細パネル">
</p>

## 🌍 どこでも動く。

**Windows と Linux**（x64・Arm64）、**macOS**（Apple シリコン）。VS Code Marketplace または **Open VSX** からインストールでき、**VS Code、Cursor、Windsurf、VSCodium** などで動きます。デバッガーもオープンソースなので、どのエディターでも F5 が使えます。

## ⚡ 30 秒で始める

1. **SharpLsp** をインストール。
2. `.sln`、`.slnx`、`.csproj`、`.fsproj` を含むフォルダーを開く。
3. コードを書く。

拡張機能には言語サーバー、2 つの .NET サイドカー、デバッガーが同梱されています。**.NET 10 SDK** がなければ Microsoft の .NET Install Tool で取得します。プロファイラーは標準の .NET 診断ツールを使います。最初に一度だけインストールしてください：

```bash
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

ワークスペースの `sharplsp.toml` ですべて調整できます。詳しくは[設定ガイド](https://sharplsp.dev/ja/docs/configuration/)を参照してください。

## 💚 オープンソース

SharpLsp は [GitHub](https://github.com/Nimblesite/SharpLsp) 上で MIT ライセンスのもと開発されています。バグ報告、アイデア、プルリクエストを歓迎します。
