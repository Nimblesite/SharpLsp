---
layout: layouts/docs.njk
title: 重构与代码操作
lang: zh
eleventyNavigation:
  key: 重构与代码操作（中文）
  order: 7
---

![VS Code 中的代码操作灯泡](/assets/screenshots/vscode-refactoring.png)

# 重构与代码操作

SharpLsp 为 C# 和 F# 支持标准 LSP 代码操作。操作取决于上下文：sidecar 只会返回编译器或提供程序能够在当前诊断、光标位置或选区上执行的修复或重构。

在 VS Code 中，可以使用灯泡或**快速修复**命令（Windows/Linux 上为 `Ctrl+.`，macOS 上为 `Cmd+.`）。

## C# 操作

C# sidecar 会从随扩展捆绑的 Roslyn 功能程序集中发现 Roslyn 代码修复和重构提供程序。它会请求提供程序返回适用于指定范围的操作，并将选中的操作解析为工作区编辑。

已验证的示例包括：

- 添加缺失的导入；
- 移除未使用的局部变量；
- 生成缺失的方法；
- 对有效类型或选区提供 Roslyn 重构。

实际列表会随语法、诊断、Roslyn 版本和可用提供程序而变化。在空白行或不受支持的位置返回空操作列表是正确行为；存在某个操作类别并不意味着 Visual Studio 中的每一项重构都可用。

## F# 操作

F# sidecar 提供一组明确的、由编译器驱动或自动生成的操作：

| 触发条件或上下文 | 操作 |
|---|---|
| `FS0039` | 能够确定命名空间时，添加可解析名称的 `open` |
| `FS1182` | 在未使用的绑定前添加 `_` |
| `FS0020` | 添加 `|> ignore` |
| `FS0025` | 添加通配符匹配分支 |
| `FS0026` | 移除冗余模式 |
| 受支持的 `FS0001` 类型不匹配 | 插入已知的类型转换 |
| 可区分联合匹配 | 生成缺失的分支 |
| 记录表达式 | 生成缺失的字段 |
| 接口实现 | 生成成员存根 |
| `SLSPF0102` / `SLSPF0103` | 移除未使用的 `open` / 简化名称 |

编译器拼写纠错和部分 FSAC 操作仍未实现；请参阅 [F# 语言支持](/zh/docs/fsharp/)。

## 解析和应用

`textDocument/codeAction` 返回轻量级操作项。`codeAction/resolve` 只为选中的操作计算编辑。解析后的工作区编辑可以修改多个已有文档。

如果操作已过期、sidecar 已重启，或提供程序无法生成可应用的操作，解析会返回空编辑，而不会猜测结果。

## 重命名是独立功能

重命名不是代码操作。SharpLsp 会声明 `textDocument/prepareRename` 和 `textDocument/rename`：

- C# 重命名使用已加载的 Roslyn 解决方案。
- F# 重命名使用已加载的 F# 项目，并可编辑多个文件。

请使用编辑器的**重命名符号**命令。

## 格式化和成员排序

SharpLsp 有意不声明 LSP 格式化能力。格式化请使用 CSharpier 或 Fantomas。VS Code 的**排序成员**命令是独立的 C# tree-sitter 操作，可以配置可访问性、类别和字母排序顺序。
