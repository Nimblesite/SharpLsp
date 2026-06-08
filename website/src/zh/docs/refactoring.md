---
layout: layouts/docs.njk
title: 重构与代码操作
lang: zh
eleventyNavigation:
  key: 重构与代码操作（中文）
  order: 7
---

![VS Code 中的代码操作灯泡](/assets/screenshots/vscode-refactoring.png)

*Alpha 版 VS Code 扩展中由 Roslyn 驱动的代码操作。*

# 重构与代码操作

SharpLsp 通过 Roslyn 路由代码操作。当光标位于受支持的符号、诊断或选择上时，VS Code 可以显示一个灯泡，提供来自 Roslyn 的快速修复和重构。

## 触发代码操作

- **灯泡**：点击编辑器边栏中出现的 💡 图标
- **键盘**：`Ctrl+.`（Windows/Linux）或 `Cmd+.`（macOS）
- **快速修复**：将光标定位在诊断波浪线上，然后按上述快捷键

## 可用操作

SharpLsp 正在朝着覆盖广泛的 Roslyn 代码操作方向构建，包括：

| 类别 | 示例 |
|----------|---------|
| 快速修复 | 添加缺失的 `using`、实现接口、添加 null 检查 |
| 重构 | 重命名、提取方法、提取变量、内联变量 |
| 样式 | 转换为表达式主体、添加/移除大括号、使用模式匹配 |
| 生成 | 生成构造函数、生成属性、生成重写 |

## 性能目标

| 指标 | 目标 |
|--------|--------|
| 代码操作列表 | <200ms p50 |
| 应用修复 | <100ms |
