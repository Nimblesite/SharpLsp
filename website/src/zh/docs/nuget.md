---
layout: layouts/docs.njk
title: NuGet 包管理器
lang: zh
eleventyNavigation:
  key: NuGet 包管理器（中文）
  order: 8
---

![NuGet 包浏览器 — 浏览选项卡](/assets/screenshots/vscode-nuget-browse.png)

*Alpha 版 VS Code 扩展中的 NuGet 包工作流。*

# NuGet 包管理器

SharpLsp 为 VS Code 内置了 NuGet 包浏览器面板，由 sidecar 和官方 NuGet API 提供支持。无需离开扩展即可安装、移除和检视包。

## 打开 NuGet 浏览器

在**解决方案资源管理器**中右键单击项目节点并选择**浏览 NuGet 包**，或在命令面板中运行命令 `SharpLsp: Browse NuGet Packages`。

## 浏览选项卡

![NuGet 包浏览器 — 搜索结果](/assets/screenshots/vscode-nuget-search.png)

**浏览**选项卡默认显示热门包。在搜索框中输入即可查找 nuget.org 上的任意包。结果会随输入实时更新。

## 已安装的包

![NuGet 包浏览器 — 已安装选项卡](/assets/screenshots/vscode-nuget-installed.png)

**已安装**选项卡列出当前项目中的所有 `<PackageReference>`。点击某个包可在右侧面板中查看其详情和版本选择器。

## 包详情

![NuGet 包详情面板](/assets/screenshots/vscode-nuget-package-details.png)

选中某个包会显示其描述、图标、当前版本，以及**安装**或**移除**按钮（具体取决于该包是否已被项目引用）。

## 响应式

NuGet 面板旨在对磁盘上的项目变更做出响应。在 alpha 阶段，请针对你的项目验证安装和移除行为后再依赖它处理关键工作流。

## 性能目标

| 操作 | 目标 |
|-----------|--------|
| 包搜索 | <500ms |
| 已安装列表加载 | <200ms |
| 安装 / 移除 | <2s |
