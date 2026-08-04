---
layout: layouts/docs.njk
title: 代码补全
lang: zh
eleventyNavigation:
  key: 代码补全（中文）
  order: 4
---

![VS Code 中的代码补全](/assets/screenshots/vscode-completions-page.png)

# 代码补全

SharpLsp 为 C# 和 F# 提供语义补全。Rust 宿主会将每个请求路由到 Roslyn 或 F# Compiler Service（FCS），然后返回带替换范围的标准 LSP 补全项。

## C# 补全

C# 补全使用 Roslyn 的 `CompletionService`。它涵盖 Roslyn 在光标位置提供的符号和关键字，包括成员、类型、命名空间、局部变量、参数和上下文关键字。

每个补全项都包含文本编辑，因此接受补全时会替换当前标识符，而不是在其后追加文本。`completionItem/resolve` 会向 Roslyn 请求最终更改，并返回所有附加编辑。对于导入补全，这些编辑可以添加所需的 `using` 指令。

## F# 补全

F# 补全使用 FCS `GetDeclarationListInfo`。目前支持成员和作用域内符号的补全，接受补全项时也能正确替换当前词元。

与 FSAC 相比仍有两项差距：

- 来自尚未打开的命名空间的符号还不会加入列表。
- `completionItem/resolve` 已实现，但尚不能插入 `open` 声明。

## 触发补全

SharpLsp 为两种语言声明 `.` 作为成员访问的自动触发字符。编辑器也可以显式请求补全，例如在 VS Code 中按 `Ctrl+Space`。

`(` 和 `,` 等字符属于签名帮助，而不是代码补全；它们会作为签名帮助的触发字符单独声明。

## LSP 能力

```json
{
  "completionProvider": {
    "resolveProvider": true,
    "triggerCharacters": ["."]
  }
}
```

补全结果基于当前尚未保存的缓冲区计算。如果相应语言的 sidecar 已禁用或不可用，SharpLsp 不会编造结果，而是返回空的语义补全项列表。
