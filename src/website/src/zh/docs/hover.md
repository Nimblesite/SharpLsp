---
layout: layouts/docs.njk
title: 悬停与快速信息
lang: zh
eleventyExcludeFromCollections: true
---

![VS Code 中的悬停信息](/assets/screenshots/vscode-hover-page.png)

# 悬停与快速信息

C# 和 F# 均已实现悬停功能。请求会路由到 Roslyn 或 FCS，并根据当前尚未保存的文档内容进行计算。

## C# 悬停

C# 悬停信息可以包括：

- 完全限定的符号签名、修饰符、参数和可空性注解；
- 成员所属的类型；
- `[Obsolete]` 消息；
- 渲染后的 XML 文档；
- `var`、数值字面量、Lambda 参数、元组元素和模式变量的推断类型。

字符串和字符字面量会有意返回空工具提示。Roslyn 同时解析声明和引用，因此悬停既可用于定义位置，也可用于使用位置。

## F# 悬停

F# 悬停使用 FCS 增强工具提示。它会返回包含 F# 签名的 Markdown 代码块，并渲染可用的 XML 文档。它支持函数、值、类型、成员、可区分联合分支及其他 FCS 符号。

## 实时缓冲区行为

打开或更改文档时，SharpLsp 会将完整文档内容发送给对应的 sidecar。因此，悬停信息会反映尚未保存到磁盘的编辑。已被新文档版本取代的请求不会覆盖较新的导航状态。

## 失败行为

如果当前位置没有符号、sidecar 已禁用或分析失败，SharpLsp 会返回 `null`，而不是显示编造的信息。sidecar 生命周期监控可以重新启动故障进程，但遇到故障的当前请求仍可能不返回工具提示。
