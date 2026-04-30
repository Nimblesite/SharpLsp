---
layout: layouts/docs.njk
title: NuGet パッケージマネージャー
lang: ja
eleventyNavigation:
  key: NuGet パッケージマネージャー（日本語）
  order: 8
---

![NuGet パッケージブラウザー — Browse タブ](/assets/screenshots/vscode-nuget-browse.png)

*Alpha 版 VS Code 拡張機能内での NuGet パッケージワークフロー。*

# NuGet パッケージマネージャー

SharpLsp には、サイドカーと公式 NuGet API を利用した、VS Code 向けの組み込み NuGet パッケージブラウザーパネルが含まれています。拡張機能を離れることなく、パッケージのインストール、削除、確認が行えます。

## NuGet ブラウザーを開く

**ソリューションエクスプローラー**でプロジェクトノードを右クリックし、**Browse NuGet Packages** を選択するか、コマンドパレットからコマンド `SharpLsp: Browse NuGet Packages` を実行します。

## Browse タブ

![NuGet パッケージブラウザー — 検索結果](/assets/screenshots/vscode-nuget-search.png)

**Browse** タブは既定で人気パッケージを表示します。検索ボックスに入力すると、nuget.org 上の任意のパッケージを検索できます。検索結果は入力に合わせてリアルタイムに更新されます。

## インストール済みパッケージ

![NuGet パッケージブラウザー — Installed タブ](/assets/screenshots/vscode-nuget-installed.png)

**Installed** タブには、アクティブなプロジェクトのすべての `<PackageReference>` が一覧表示されます。パッケージをクリックすると、右側のパネルにその詳細とバージョン選択が表示されます。

## パッケージ詳細

![NuGet パッケージ詳細パネル](/assets/screenshots/vscode-nuget-package-details.png)

パッケージを選択すると、その説明、アイコン、現在のバージョン、およびプロジェクトから参照済みかどうかに応じて **Install** または **Remove** ボタンが表示されます。

## リアクティブ性

NuGet パネルは、ディスク上のプロジェクト変更に追従することを目的としています。Alpha 版では、重要なワークフローでの利用前にプロジェクトに対するインストールおよび削除挙動を検証してください。

## パフォーマンス目標

| 操作 | 目標 |
|------|------|
| パッケージ検索 | <500ms |
| インストール済み一覧の読み込み | <200ms |
| インストール / 削除 | <2s |
