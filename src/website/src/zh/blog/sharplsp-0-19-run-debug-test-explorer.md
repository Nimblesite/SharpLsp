---
layout: layouts/blog.njk
title: "SharpLsp 0.19.0：可以信赖的运行、调试与测试循环"
description: "SharpLsp 0.19.0 从根本原因上修复了 VS Code 的运行/调试体验——启动配置文件发现、多配置文件选择提示、可取消的构建——并通过全新的 DapRouter 重建逻辑异步调用栈，以 4,800 行端到端测试加固 Test Explorer。"
lang: zh
date: 2026-08-30
author: SharpLsp 团队
image: /assets/images/blog/sharplsp-0-19-run-debug-test-explorer.png
imageAlt: 终端中显示启动配置文件选择提示、重建后的异步调用栈与通过的测试结果
tags:
  - posts
  - announcement
  - csharp
  - fsharp
  - dotnet-lsp
category: announcement
excerpt: "0.19.0 真正修复了内循环：F5 与启动配置文件的行为与 dotnet run 一致，异步栈读起来就是你写的代码而不是一堆 MoveNext，Test Explorer 背后有 4,800 行端到端测试。"
---

版本 0.19.0 的主题是内循环：按下 F5，选择启动配置文件，命中断点，读懂调用栈，运行测试。这整个循环现在都能正常工作——更重要的是，我们能证明它正常工作，因为它的每一个环节都被端到端测试覆盖：这些测试构建真实项目，并断言真实结果。

本版本发布了全部五个平台的 VSIX 包——win32-x64/arm64、linux-x64/arm64 和 darwin-arm64——并附带 SHA256 校验和，可在[发布页面](https://github.com/Nimblesite/SharpLsp/releases/tag/v0.19.0)获取。以下是变更内容。

## F5 与启动配置文件，真正修好

此前的运行/调试体验存在一些靠界面打磨掩盖不了的问题：`dotnet run` 能看到而扩展看不到的配置文件、项目含有多个配置文件时的静默失败、以及无法取消的构建。我们对这三个问题都做了根本原因修复。

- **启动配置文件发现**。扩展现在通过与 `dotnet run` 相同的 MSBuild 评估来解析启动配置文件，包括之前因 `TargetPath` 评估而隐藏了有效配置文件的情况。如果 `dotnet run --launch-profile X` 能启动你的应用，那么用配置文件 X 按 F5 也能启动。
- **多配置文件提示**。拥有多个启动配置文件的项目现在会提示你选择，而不是静默选定一个——或者干脆启动失败。
- **可取消的构建**。`applyTarget` 现在会启动真正的构建并尊重取消操作。此前它实际上是即发即忘，意味着调试器可能与仍在输出二进制文件的构建发生竞态。

运行/调试的端到端测试块 21/21 全部通过。这些套件会启动真实的项目文件、附加调试器并验证行为——它们不模拟调试器。

## 读起来像你代码的异步调用栈

调试异步 C# 代码，长期以来就意味着眯着眼睛看状态机内部：看到的是一堵 `MoveNext` 帧的墙，而不是你实际写下的 `await` 链。本版本引入了 **DapRouter**（`dap-router.ts` + `dap-frames.ts`），一个调试适配器协议（DAP）的路由层，在内容到达编辑器之前**重建逻辑异步调用栈**。

有了这个路由器，在一个被等待的调用中暂停时，看到的就是你期望的调用链：

```
ProcessOrders()
  await ChargeCardAsync()
    await Gateway.PostAsync()   ← paused here
```

而不是三层编译器生成的管道装置。

DapRouter 使用 DAP 1.71，也是后续工作的基础：netcoredbg 与 ICorDebug 路径在它背后可以互换，而路线图上的功能——logpoints、`DebuggerDisplay` 仿真、热重载协调——都构建在同一套管道之上。

## 有端到端证明支撑的 Test Explorer

测试资源管理器会悄悄腐烂：发现功能在演示项目上正常，到了你的项目上就失败。版本 0.19.0 新增了**七个端到端测试套件——约 4,800 行测试**——覆盖以下方面：

- **Frameworks** —— 支持的测试框架范围内的发现与执行
- **Outcomes** —— 准确报告通过、失败与跳过的结果
- **Parsers** —— 将测试输出解析为真实结果，而不只是文本
- **Reactivity** —— 结果到达时树随之更新
- **Windows** —— 在行为与众不同的平台上验证表现
- **Kit** —— 其他套件构建所依赖的辅助工具

结果断言检查的是实际运行的内容，而不仅仅是界面上渲染的内容。而且这些行为如今写在 `TEST-EXPLORER-SPEC.md` 中，是文档化的契约，而不是口口相传的惯例。

## 不会悄悄腐烂的编辑器扩展

本版本中最有价值的修复，可能是你永远不会看到的那个。在 0.19.0 周期中，我们发现 SharpLsp 自己的 Zed 扩展曾随附从未执行过的测试套件——其中一些还是断言常量等于自身的同义反复。绿灯管道里空无一物。这正是制造出本文所讨论的这类发布的失败模式，因此我们从结构上修复了它：

- **Zed**：31/31 测试通过，85.04% 的行覆盖率纳入 CI 门禁。同义反复测试已被清除，版本一致性测试真正解析 `extension.toml`，管道逻辑被抽取到可直接测试的 `pipeline.rs` 中。
- **Rider**：这个 Kotlin 插件——2,961 行代码，此前*测试数量为零、CI 存在感为零*——如今有了最初的八个测试（NuGet 状态合并、不区分大小写的包 ID 匹配、排序顺序、pending 标志），并通过新的 `ci-editors.yml` 管道在每次 PR 时编译。
- **不允许静默的空**：所有编辑器测试分支启用 `failOnNoDiscoveredTests = true`，什么都没发现的任务永远无法再报告成功。

## 构建与发布加固

其余的改动是保持发布本身诚实的隐形管道：

- **VSIX 载荷验证器**（`verify-vsix-payload.mjs`）检查发布的内容就是我们构建的内容——没有缺失的 sidecar，没有过期的产物。
- **netcoredbg 获取修复**让构建期间调试器二进制文件的解析保持稳定。
- Rust 宿主收到了 `semantic_tokens` 的 clippy 修复，网站增加了 Mermaid 渲染测试。
- 完整的 .NET 测试套件——983 个测试——在本版本的 CI 中全部通过。

## 获取 0.19.0

从[发布页面](https://github.com/Nimblesite/SharpLsp/releases/tag/v0.19.0)安装（各平台 VSIX 及 SHA256 校验和），阅读[文档](https://sharplsp.dev/docs/)，如果内循环在你的项目上出了问题——[那正是我们想要的 issue](https://github.com/Nimblesite/SharpLsp/issues)。
