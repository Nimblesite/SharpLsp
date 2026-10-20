---
layout: layouts/docs.njk
title: 教程
description: "VS Code 中的 SharpLsp 交互式教程：每一步一段短片，先 F# 后 C#。当 SharpLsp 响应你的悬停、补全、F12 或代码操作时，该步骤会自动完成。"
lang: zh
---

# SharpLsp 教程

SharpLsp 在 VS Code 里教你使用它。教程为每一步播放一段短片，你同时在自己的编辑器里、用自己的代码完成这一步。SharpLsp 响应该操作后，此步骤会自动打勾，下一段短片随即开始。没有“标记为完成”按钮：没有返回任何内容的悬停不算数。

先学 F#，再学 C#。两种语言的步骤相同，各有七步。

{% video "vscode-tutorial" %}

## 打开教程

- **首次运行。** SharpLsp 第一次启动时，会在 VS Code 的“入门”页面打开 F# 演练，并在旁边打开教程面板。
- **随时打开。** 在命令面板（Cmd+Shift+P，Windows 和 Linux 上为 Ctrl+Shift+P）中运行 **SharpLsp: 打开教程**。
- **“入门”页面。** 打开 **帮助 → 欢迎**，然后选择 **通过 F# 学习 SharpLsp** 或 **通过 C# 学习 SharpLsp**。

面板中有 F# 和 C# 切换、该语言的七个步骤，以及当前步骤的短片。**Open one for me** 会打开已加载解决方案中的一个源文件，让后续每一步都有可响应的内容。

## 步骤

短片中的每一步，先 F#。选择一个时间即可从该步骤开始观看：

{% chapters "vscode-tutorial" %}

| 步骤 | 你要做的 | 完成条件 |
|------|-----|---------------|
| 打开文件 | 打开一个 F# 或 C# 源文件 | 该语言的编辑器成为活动编辑器 |
| 悬停 | 将鼠标停在函数、类型或值上 | SharpLsp 返回快速信息 |
| 补全代码 | 在值后输入一个点，或按 Ctrl+Space | SharpLsp 返回至少一个补全项 |
| 转到定义 | 将光标放在符号上并按 F12 | SharpLsp 找到定义 |
| 查找所有引用 | 将光标放在符号上并按 Shift+F12 | SharpLsp 找到至少一个引用 |
| 修复代码 | 在警告或错误上按 Cmd+.（Windows 和 Linux 上为 Ctrl+.） | SharpLsp 提供至少一个代码操作 |
| 解决方案资源管理器 | 点击活动栏中的 SharpLsp 图标 | 解决方案资源管理器打开（两种语言同时完成） |

面板为每一步播放对应文档页的短片：[悬停](/zh/docs/hover/)、[代码补全](/zh/docs/completions/)、[转到定义](/zh/docs/go-to-definition/)和[重构课程](/zh/docs/refactoring/)。

## 设置

- `sharplsp.tutorial.showOnStartup`（默认 `true`）：设为 `false` 后，首次运行时不再自动打开教程。
- **SharpLsp: 重置教程进度** 会清除所有完成标记，让你重新学习教程。

教程也可以在用 `code serve-web` 从你自己的机器提供的浏览器版 VS Code 中运行。vscode.dev 和 github.dev 没有本地扩展主机，因此无法运行 SharpLsp。

<p class="next-link"><a href="/zh/docs/editors/">下一节：编辑器设置 <span aria-hidden="true">→</span></a></p>
