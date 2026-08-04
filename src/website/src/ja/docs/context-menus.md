---
layout: layouts/docs.njk
title: コンテキストメニュー
lang: ja
eleventyNavigation:
  key: コンテキストメニュー（日本語）
  order: 9
---

![VS Code の SharpLsp ソリューションエクスプローラー](/assets/screenshots/solution-explorer.png)

# コンテキストメニュー

SharpLsp のコンテキストメニューコマンドの大半は、VS Code のソリューションエクスプローラーにあります。現在、拡張機能は Problems パネルにコンテキストメニューを追加しません。

## ソリューションエクスプローラー

| ノード | 利用可能なアクション |
|---|---|
| ソリューション | Build、Rebuild、Clean、Remove Unused Packages、Consolidate Packages、Copy Name |
| プロジェクト | Open Project File、Build、Rebuild、Clean、Browse NuGet Packages、Remove Unused Packages、Copy Name |
| 依存関係フォルダー | Add Project Reference、Add NuGet Package |
| NuGet パッケージ | Remove Package |
| プロジェクト参照 | Remove Project Reference |
| 型シンボル（C#） | Sort Members、Reveal in Explorer、Copy Qualified Name、Copy Name |
| その他のソースシンボル | Reveal in Explorer、Copy Qualified Name、Copy Name |

### Build、Rebuild、Clean

各コマンドは、選択したソリューションまたはプロジェクトを対象にします。

- **Build:** `dotnet build <target>`
- **Rebuild:** `dotnet build <target> --no-incremental`
- **Clean:** `dotnet clean <target>`

ビルド出力はターミナルに表示され、解析されたコンパイラーのエラーと警告は VS Code の診断に追加されます。

### Open Project File

選択した `.csproj` または `.fsproj` をエディターで開きます。

### Add Project Reference

このアクションは、プロジェクトの依存関係フォルダーノードに表示されます。検出された他のプロジェクトをクイックピック一覧に表示し、選択後にプロジェクト参照を編集します。

### NuGet アクション

**Browse NuGet Packages** は、選択したプロジェクトを対象に [NuGet パッケージマネージャー](/ja/docs/nuget/)を開きます。また、依存関係ノードとパッケージノードでは、該当する場合にパッケージの追加、削除、未使用パッケージの処理、統合の各ワークフローを利用できます。

### シンボルアクション

- **Copy Qualified Name** は、ソースシンボルの完全修飾名をコピーします。
- **Copy Name** は短い名前をコピーします。プロジェクトノードとソリューションノードでも利用できます。
- **Reveal in Explorer** は、シンボルのソースファイルをファイルエクスプローラーに表示します。
- **Sort Members** は、C# のクラス、構造体、インターフェイス、列挙型、レコードの各ノードで動作します。常に名前だけで並べ替えるのではなく、設定されたアクセシビリティ／カテゴリ／アルファベット順の階層に従います。

## エディターメニュー

C# と F# のエディターでは、SharpLsp が **Debug Program** を追加します。コードアクション、名前変更、ナビゲーションなどの言語操作には、SharpLsp 固有のコンテキスト項目ではなく、VS Code 標準の LSP メニューとコマンドを使用します。
