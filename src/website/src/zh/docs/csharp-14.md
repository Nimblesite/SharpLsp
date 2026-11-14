---
layout: layouts/docs.njk
lang: zh
title: "在 VS Code 中使用 C# 14"
description: "使用 SharpLsp 体验扩展成员、field 和 null 条件赋值。"
---

# 在 VS Code 中使用 C# 14

使用 .NET 10 项目和 SharpLsp 体验 C# 14 功能。

{% video "csharp-14" %}

## 扩展成员

扩展成员可以为现有类型添加属性和方法。通过补全、悬停和 F12 查看扩展属性及其声明。

## field

field 关键字在属性访问器中访问编译器生成的后备字段，无需另行声明字段。

## ?. =

customer?.Name = "Ada"; 会在 customer 为 null 时跳过赋值。
