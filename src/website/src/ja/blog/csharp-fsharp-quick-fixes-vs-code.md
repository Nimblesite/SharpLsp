---
layout: layouts/blog.njk
title: "Visual Studio Code での C# と F# のクイックフィックス"
description: "SharpLsp が C# と F# の明示的なインポート選択肢と、C# の型をファイルへ移すリファクタリングを追加。VS Code の電球から欠けている名前空間を解決できます。"
date: 2026-11-10
author: SharpLsp Team
image: /assets/images/blog/csharp-fsharp-quick-fixes-vs-code.webp
imageAlt: "アイボリー色の F# と C# のタイルをエメラルドのラインでつないだ図"
lang: ja
tags:
  - posts
  - csharp
  - fsharp
  - dotnet-lsp
category: announcement
excerpt: "名前空間のインポート、その箇所だけの修飾、静的メンバーのインポートから選べます。SharpLsp のクイックフィックスは、適用前にどの編集を行うかを明示します。"
---

{# Google Trends checked 2026-11-10, Worldwide, past 12 months, Web Search.
Comparison averages: C# 55, Visual Studio Code 20, F# 3, code refactoring 1 (normalized interest, not search counts).
https://trends.google.com/trends/explore?date=today%2012-m&q=Visual%20Studio%20Code,C%23,F%23,code%20refactoring
Title uses the broader relevant terms. No rising-trend claim.
Header generated with the built-in image tool: ivory F# and C# ceramic tiles joined by an emerald connector, off-white studio background, soft shadows, no extra text. #}

未解決の名前には、名前空間、修飾名、または欠けているプロジェクト参照が必要な場合があります。SharpLsp の C# と F# のクイックフィックスは、どの変更を行うかを事前に伝えるようになりました。これらの改善はバージョン 0.32 で提供され、0.33 でも引き続き利用できます。

Visual Studio Code では、エラーにカーソルを置いて **Ctrl+.**（macOS では **Cmd+.**）を押します。

## F# のインポート

未解決の `StringBuilder` に対して、`open System.Text` を選ぶか、その箇所を `System.Text.StringBuilder` と修飾できます。`Sqrt` のような静的メンバーには、`open type System.Math` がメニューに提案されることがあります。

補完でも、開かれていない名前空間の型が候補に現れ、確定するとその `open` を挿入します。クイックフィックスのタイトルは、各インポートが何をスコープに取り込むかを説明します。対応しているプロジェクト参照やパッケージ参照が欠けている場合は、別のアクションが追加する参照の名前を示します。

## C# のインポート

同じ `StringBuilder` のエラーに対して、三つの編集から選べます。

- `using System.Text;` を追加する。
- `using StringBuilder = System.Text.StringBuilder;` で型だけをインポートする。
- その箇所を `System.Text.StringBuilder` と修飾する。

静的メンバーには `using static` の修正も提案されることがあります。アクションを適用できない場合は、その理由が報告されます。

## C# の型を専用のファイルへ移す

型名にカーソルを置いて **Move type to Receipt.cs** を選ぶと、`Receipt` に専用のファイルが与えられます。名前空間、インポート、ドキュメント、属性も一緒に移動します。

入れ子の型には、別の **Move 'Inner' out of 'Outer' to Inner.cs** アクションがあります。これによりトップレベルの型になり、ソリューション全体の参照が更新されます。このアクションは、移動を提案する前に名前の衝突やアクセスできないコンテナー メンバーをチェックします。

SharpLsp は [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) からインストールできます。ショートカットと対応アクションについては[リファクタリングガイド](/ja/docs/refactoring/)を参照してください。
