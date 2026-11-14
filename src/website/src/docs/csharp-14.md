---
layout: layouts/docs.njk
lang: en
title: "C# 14 in VS Code"
description: "Explore extension members, field and null-conditional assignment with SharpLsp."
---

# C# 14 in VS Code

Use a .NET 10 project with SharpLsp to try three C# 14 features.

{% video "csharp-14" %}

## Extension members

Extension members add properties as well as methods to existing types. Type `text.` to find an extension property in completion, hover to inspect it, and press F12 to reach its declaration.

## field

The `field` keyword accesses the compiler-generated backing field inside a property accessor. A setter can validate a value without declaring a separate field.

## ?. =

Null-conditional assignment allows `customer?.Name = "Ada";`. When the receiver is null, the assignment is skipped.
