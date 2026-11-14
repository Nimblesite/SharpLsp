---
layout: layouts/docs.njk
lang: ja
title: "VS Code で C# 14"
description: "SharpLsp で拡張メンバー、field、null 条件付き代入を試します。"
---

# VS Code で C# 14

.NET 10 プロジェクトと SharpLsp で C# 14 の機能を試します。

{% video "csharp-14" %}

## 拡張メンバー

拡張メンバーでは既存の型にプロパティやメソッドを追加できます。補完、ホバー、F12 で宣言への移動を確認できます。

## field

field キーワードはプロパティのアクセサー内でコンパイラー生成のバッキングフィールドにアクセスします。

## ?. =

customer?.Name = "Ada"; は、customer が null の場合に代入をスキップします。
