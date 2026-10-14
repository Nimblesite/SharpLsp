---
layout: layouts/blog.njk
title: "Test Explorer 中的 Microsoft.Testing.Platform (MTP)：C# 与 F# 的 dotnet test、xUnit v3、MSTest 和 NUnit"
description: "SharpLsp 的 VS Code Test Explorer 现在可与 VSTest 并行发现、运行、调试 C# 和 F# 的 Microsoft.Testing.Platform (MTP) 测试并收集覆盖率。本文介绍 MTP 上的 dotnet test、启用方式，以及我们修复的问题。"
lang: zh
date: 2026-09-22
author: SharpLsp 团队
image: /assets/images/blog/microsoft-testing-platform-mtp-dotnet-test-csharp-fsharp.png
imageAlt: dotnet test 模块将 C# 和 F# 的 xUnit v3、MSTest、NUnit 测试列入 SharpLsp Test Explorer
tags:
  - posts
  - testing
  - csharp
  - fsharp
  - dotnet-lsp
category: testing
excerpt: "xUnit v3 4.0 只支持 Microsoft.Testing.Platform；仅支持 VSTest 的 Test Explorer 会显示空树。SharpLsp 现在可在 C# 和 F# 中并行使用 MTP 与 VSTest，包括发现、▶、调试和代码覆盖率。"
---

对 .NET 开发者来说，`dotnet test` 的底层正在变化。**Microsoft.Testing.Platform (MTP)** 是取代 **VSTest** 的新测试平台。测试项目会构建为可执行的*测试模块*，自行发现并运行测试；中间不再需要单独的 `testhost` 进程或适配器。MSTest、NUnit 和 xUnit 都提供 MTP 运行器，而 **xUnit v3 4.0 *只*支持 MTP v2**：它根本没有 VSTest 适配器。

因此，如果编辑器的 Test Explorer 只支持 VSTest，现代 xUnit v3 项目的测试树就会**一片空白**。测试确实存在，`dotnet test` 也能运行，但编辑器什么都看不到。

SharpLsp 的 Test Explorer 现在同时支持两者。该功能已进入 `main`，并将在下一版本发布。它能发现、运行、调试 C# 和 F# 的 **xUnit v3、MSTest、NUnit** MTP 测试模块，并收集代码覆盖率。它也能与 VSTest 项目并行工作，包括在一个多根工作区中同时使用两种平台。本文介绍：

- Microsoft.Testing.Platform 上的 `dotnet test` 如何工作；
- 如何在 C# 或 F# 项目中启用它；
- Test Explorer 会如何处理它；
- 为确保结果可信，我们修复了哪些真实问题。

## 感谢 Valentin Dide

这项功能源于 **[Valentin Dide (@validide)](https://github.com/validide)** 遇到了空测试树，并提交了 [issue #249“Test Explorer 支持 Microsoft.Testing.Platform (MTP)”](https://github.com/Nimblesite/SharpLsp/issues/249)。Valentin 还在 [PR #250“Test Explorer 支持 Microsoft.Testing.Platform”](https://github.com/Nimblesite/SharpLsp/pull/250)中完成了关键实现：

- 识别 MTP；
- 使用 `--list-tests json` 发现测试；
- 使用 `--filter-uid` 运行测试；
- 读取 TRX 结果；
- 为 MTP 模块添加 Debug 配置；
- 建立覆盖两种语言、所有框架的六项目端到端测试夹具。

本文所述的一切都建立在该 PR 之上。感谢 Valentin：这正是开源 .NET 工具协作应有的样子。

## 一段话理解 MTP 与 VSTest

在 **VSTest** 下，`dotnet test` 构建项目，再把程序集交给测试宿主。宿主加载框架*适配器*（`xunit.runner.visualstudio`、`NUnit3TestAdapter`、`MSTest.TestAdapter`），由适配器发现并运行测试。

在 **Microsoft.Testing.Platform** 下，测试项目本身就是运行器。它会构建成带有自身命令行的可执行模块：

- `--list-tests` 列出测试；
- `--filter-uid` 选择测试；
- `--report-trx` 写出报告；
- `--coverage` 收集代码覆盖率。

TRX 和覆盖率等功能是**扩展**：模块必须引用并注册相应 NuGet 包，它们不是平台始终自带的开关。后面大多数行为都源于这个区别。

## 如何启用：C# 与 F#

在 .NET 10 SDK 中，`dotnet test` 根据 `global.json` 选择运行模式：

```json
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

SharpLsp 也会先读取这一配置。没有 `global.json` 的项目仍会被发现：SharpLsp 会询问 MSBuild 该项目是否为 Testing Platform 应用。因此，即使 MTP 项目位于 VSTest 仓库内，它的测试也会出现。

一个使用 MTP 的 **C# xUnit v3** 测试项目：

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit.v3" Version="4.0.0" />
    <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.4.0" />
  </ItemGroup>
</Project>
```

**F# xUnit v3** 测试项目使用相同的项目配置，另加 F# 必需的编译顺序：

```xml
<ItemGroup>
  <Compile Include="Tests.fs" />
</ItemGroup>
```

```fsharp
module MyApp.Tests.Calculator

open Xunit

[<Fact>]
let ``adds two numbers`` () = Assert.Equal(3, 1 + 2)

[<Theory>]
[<InlineData(1, 2, 3)>]
[<InlineData(2, 2, 4)>]
let ``adds rows`` (a: int) (b: int) (expected: int) = Assert.Equal(expected, a + b)
```

MTP 上的 **MSTest** 需要引用 `MSTest` 4.x，并设置 `<EnableMSTestRunner>true</EnableMSTestRunner>`。**NUnit** 需要引用 `NUnit` 与 `NUnit3TestAdapter` 6.x，并设置 `<EnableNUnitRunner>true</EnableNUnitRunner>`。三者都需要 `<OutputType>Exe</OutputType>`，因为模块*就是*可执行程序。

xUnit v3 和 NUnit **必须引用 `Microsoft.Testing.Extensions.TrxReport`**（MSTest 已自带）。否则模块会拒绝 `--report-trx`，无法报告逐项测试结果。Test Explorer 此时会明确告诉你要添加哪个包，而不是显示一整屏“No result reported”。

## Test Explorer 如何处理 MTP 模块

**发现。** SharpLsp 先构建发现目标，然后直接调用各个已构建模块：`dotnet exec <module> --list-tests json`。它不通过 `dotnet test`，因为 `dotnet test` 不转发 `json` 参数（[dotnet/sdk#49754](https://github.com/dotnet/sdk/issues/49754)）。它能转发的文本列表只有显示名，而 MSTest 会把显示名写成简单的方法名。

JSON 列表包含每项测试的命名空间、类型、方法和**源代码位置**，因此点击 MTP 测试行会跳到编写该测试的那一行。测试树为 **Assembly → Namespace → Class → Test**，与 VSTest 相同。

低于 2.3 版的 Testing Platform 模块不能输出 JSON 列表。日志和测试树都会提示你更新框架包。

**运行（▶）。** 整个选择集每个模块只启动一次，而不是每个测试启动一次。一个有二十项测试的类不会产生二十次进程启动。选择项以 `--filter-uid` 值传递。它是**测试矩阵中所有 MTP 框架都接受的 `dotnet test` 过滤方式**，使用无需转义的字面值，这对于 NUnit 的 `Adds_Case(2,2,4)` 之类的 uid 尤其重要。

结果通过 `--report-trx` 返回，并由 VSTest 路径使用的同一个 TRX 读取器处理。通过、失败和跳过都是真实结果，断言文本来自框架本身。数据驱动测试（xUnit 的 `[Theory]`、MSTest 的 `[DataRow]` 或 NUnit 的 `[TestCase]`）在树中占一行，并按其**最差**数据行判定结果。

**代码覆盖率。** 模块引用 `Microsoft.Testing.Extensions.CodeCoverage` 后，Run with Coverage 会传入 `--coverage --coverage-output-format cobertura`。MTP 在结果目录中直接写出 `<guid>.cobertura.xml`；coverlet 的 `coverage.cobertura.xml` 则位于下一层目录。读取器会到各收集器实际输出的深度查找。

如果你在搜索“MTP 上的 dotnet test 代码覆盖率”，答案就是这个包加这两个参数。缺少该包的模块会收到点名说明。

**调试。** Debug 配置通过 `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` 启动模块。模块打印自己的 pid 并等待；SharpLsp 将基于 netcoredbg 的调试器附加到这个确切的进程。测试体中的断点能够绑定并停住，Just My Code、局部变量和监视表达式均可使用。调试运行绝不会在树中写入虚构结果。

**VSTest 与 MTP 并行。** 运行器按发现目标选择，而非按工作区统一选择。在同时包含 VSTest 文件夹和 MTP 文件夹的多根工作区里，每项测试都会送往发现它的运行器。运行前，每个 MTP 模块都在自己的文件夹中重新构建。

## F# 绝非事后补充

SharpLsp 将 [F# 视为一等语言](/zh/blog/why-fsharp-is-first-class-in-sharplsp/)，因此每个 MTP 场景都在 F# 和 C# 中得到验证：

- **带空格的反引号名称**（例如 ``` ``adds two numbers`` ```）会原样进入测试树、过滤器和调试器。
- **F# 模块**会编译成 CLR 类型，因此 `MyApp.Tests.Calculator` 与 C# 类一样显示为命名空间 `MyApp.Tests` → 类 `Calculator`。
- **F# 的 `[<Theory>]` 数据行**在一个 id 下有各自的 uid。调试时每行都会停住，并保留自己的 `[<InlineData>]` 参数。
- **同时含空格和括号的 NUnit `[<TestCase>]` 绑定**会让 NUnit 拒绝它*自己*把 `--filter-uid` 翻译成的过滤表达式。SharpLsp 检测到拒绝后，不带过滤器重新运行模块一次，再按名称从报告中提取结果。
- **多目标 F# 模块**（`<TargetFrameworks>net9.0;net10.0</TargetFrameworks>`）中的 `#if NET9_0` 块，会在同一个树根下报告每个框架的结果，每个模块拥有独立的 TRX 报告。
- **将 F# 项目原地从 VSTest 迁移到 MTP** 时，测试 id 和测试树保持不变。SharpLsp 在下一次刷新时读取 `global.json` 的启用设置，下一次 ▶ 就会使用 MTP。
- **在 `.fs` 文件中调试光标所在测试**时，会像 Testing 视图一样附加到等待中的 F# 模块。

## 为确保可信而修复的问题

让 MTP 在演示项目里“能用”很容易；让它在你的项目里给出正确结果才是难点。审查并加固该功能时，我们发现了真实缺陷。每项修复都先写出失败的端到端测试，再从根因解决：

- **旧模块。** `dotnet exec` 不会构建项目，刚编辑的测试会以*编辑前*的内容运行。现在每次 MTP 运行都会先重新构建目标。
- **TRX 冲突。** 同一项目的两个目标框架会构建同名模块，报告因此相互覆盖。现在每次调用的报告都有独立编号。
- **模块失败丢失。** 一个模块完全失败时，它的消息可能被另一个模块的结果抹掉。现在每个模块的失败都会保留。
- **排在刷新后面的运行使用旧运行器。** 项目刚切到 MTP，发现任务仍在排队时按 ▶，运行却发出 MTP 不接受的 `dotnet test --filter … --logger trx`。现在发现结果会在其自身的队列任务中应用，排在后面的运行就会使用新发现的运行器。
- **带 TRX 扩展的调试。** `Microsoft.Testing.Extensions.TrxReport` 的宿主控制器会在相同环境下重新启动测试宿主。设置 `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` 后两个进程都会等待调试器。调试运行现在跳过 `--report-trx`。
- **编辑 Theory 数据行后误报绿色。** 这是最新修复。`--filter-uid` 值是模块自己的键，而各框架生成键的方式不同：
  - **xUnit v3** 将 Theory 行的数据哈希进 uid；
  - **MSTest** 按数据行的位置生成键。

  添加数据行或修改 xUnit 行的数据，会生成发现阶段从未见过的 uid。若用旧 uid 过滤重新构建的模块，**刚修改的那一行**就不会运行，改成失败的行仍被报告为**绿色**。现在 SharpLsp 会在过滤运行前重新列出已构建模块的测试，并选择该构建中确实存在的 uid。

## MTP 上的 xUnit、MSTest 与 NUnit

如果你在新项目中比较 **xUnit 与 MSTest** 或 **NUnit 与 xUnit**，从编辑器角度看，三者在 Microsoft.Testing.Platform 上的表现如下：

| | xUnit v3 | MSTest | NUnit |
|---|---|---|---|
| VSTest 适配器 | 4.0 起没有（仅 MTP） | 有 | 有 |
| TRX 报告 | 添加 `Microsoft.Testing.Extensions.TrxReport` | 内置 | 添加 `Microsoft.Testing.Extensions.TrxReport` |
| `--list-tests json` 中的源代码位置 | 有 | 有 | 无 |
| 数据行 uid | 行数据的哈希 | 行的位置 | 修饰后的名称，例如 `Adds_Case(2,2,4)` |
| 显示名 | 完全限定名 | 简单方法名 | 带参数的方法名 |

这些差异本身不是选用哪个框架的理由。它们说明 Test Explorer 绝不能根据显示名构造测试 id，也不能信任昨天的 uid。

## 使用真实项目验证

MTP 支持由端到端测试覆盖。这些测试在真实的 VS Code 扩展宿主中构建真实的 `.csproj` 和 `.fsproj` 文件：

- C# 和 F# 各自的 xUnit v3、MSTest、NUnit；
- 多目标模块；
- 缺少 TRX 或覆盖率扩展的模块；
- 超出一条命令行长度的选择集；
- 混用 VSTest 和 MTP 的工作区；
- 排在刷新后的运行；
- 在 C# 和 F# 中使用真实断点调试；
- 在发现和 ▶ 之间编辑、增加的数据行。

它们与 VSTest 套件并列，在 Windows 和 Linux 的 CI 中由各自的任务运行。

## 常见问题

**如何在 Microsoft.Testing.Platform 上运行 `dotnet test`？** 使用 .NET 10 SDK 时，在 `global.json` 中添加 `"test": { "runner": "Microsoft.Testing.Platform" }`，并使用支持 MTP 的框架包（xUnit v3、设置 `EnableMSTestRunner` 的 MSTest，或设置 `EnableNUnitRunner` 的 NUnit）。

**xUnit v3 能与 VSTest 配合使用吗？** 4.0 起不行：`xunit.v3` 4.x 只支持 MTP v2，不带 VSTest 适配器。

**如何在 MTP 中过滤测试？** 每个框架都有自己的过滤选项。`--filter-uid` 是平台自身的过滤器，也是 SharpLsp 的 ▶ 所用的过滤器，因此一次选择就精确对应你选中的测试。

**如何通过 MTP 上的 `dotnet test` 获取代码覆盖率？** 引用 `Microsoft.Testing.Extensions.CodeCoverage`，并传入 `--coverage --coverage-output-format cobertura`。SharpLsp Test Explorer 的 Run with Coverage 会替你执行。

**一个仓库能混用 VSTest 与 MTP 项目吗？** 可以。SharpLsp 按发现目标选择运行器，将每项测试送往发现它的运行器。

## 立即试用

MTP 支持将在 SharpLsp 0.21.0 之后的下一个版本提供。你可以关注[发布页面](https://github.com/Nimblesite/SharpLsp/releases)，或者现在就从 `main` 构建 VS Code 扩展。打开包含 Microsoft.Testing.Platform 上的 xUnit v3、MSTest 或 NUnit 项目的解决方案，再打开 Testing 视图。如果 MTP 项目显示空树、错误结果，或者调试器始终无法附加，请[提交 issue](https://github.com/Nimblesite/SharpLsp/issues)。这项功能正是从 issue 开始的。
