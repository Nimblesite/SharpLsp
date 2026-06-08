---
layout: layouts/docs.njk
title: コンテキストメニュー
lang: ja
eleventyNavigation:
  key: コンテキストメニュー（日本語）
  order: 9
---

![VS Code の SharpLsp ソリューションエクスプローラー](/assets/screenshots/solution-explorer.png)

*ソリューションエクスプローラーの任意のノードを右クリックすると、コンテキストに応じたアクションが表示されます。*

# コンテキストメニュー

SharpLsp は、VS Code 全体にわたって豊富なコンテキストメニューを追加します — ソリューションエクスプローラーのツリー、エディター、Problems パネルです。すべてのアクションは、対象となるノード種別に厳密にスコープが絞られています。

## ソリューションエクスプローラーのコンテキストメニュー

ソリューションエクスプローラーでノードを右クリックすると、そのノードに適したアクションが表示されます。

| ノード種別 | 利用可能なアクション |
|-----------|----------------------|
| ソリューション | Copy Name |
| プロジェクト | Open Project File、Build、Rebuild、Clean、Browse NuGet Packages、Add Project Reference、Copy Name |
| 名前空間 | Copy Qualified Name、Copy Name、Reveal in Explorer |
| クラス / 構造体 / インターフェイス / 列挙型 / レコード | Sort Members、Copy Qualified Name、Copy Name、Reveal in Explorer |
| メソッド / プロパティ / フィールド / イベント | Copy Qualified Name、Copy Name、Reveal in Explorer |

### Copy Qualified Name

選択したシンボルの完全修飾名をクリップボードにコピーします — 例: `MyNamespace.MyClass.MyMethod`。ロギング、ドキュメント、テストアサーションに役立ちます。

### Copy Name

修飾されていない名前をコピーします — 例: `MyMethod`。ソリューションノードやプロジェクトノードを含む、すべてのノード種別で利用できます。

### Reveal in Explorer

選択したシンボルを定義しているソースファイルを VS Code のファイルエクスプローラーで開きます。

### Sort Members

クラス、構造体、インターフェイス、列挙型、またはレコードのメンバーをアルファベット順に並べ替えます。型レベルのノードでのみ利用できます。

### Build / Rebuild / Clean

選択したプロジェクトに対して、`dotnet build`、`dotnet build --no-incremental`、または `dotnet clean` を実行します。

### Open Project File

![Open Project File — エディターで開かれた .csproj](/assets/screenshots/vscode-context-menu-open-project.png)

エディターで `.csproj` または `.fsproj` ファイルを開きます。

### Browse NuGet Packages

選択したプロジェクトをスコープとして [NuGet パッケージマネージャー](./nuget.md) パネルを開きます。

### Add Project Reference

参照する別のプロジェクトを選択するためのファイルピッカーを開きます。
