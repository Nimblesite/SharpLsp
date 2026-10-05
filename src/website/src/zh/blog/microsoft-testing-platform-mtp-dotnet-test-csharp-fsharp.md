---
layout: layouts/blog.njk
title: "Test Explorer 中的 Microsoft.Testing.Platform（MTP）：C# 与 F# 的 dotnet test、xUnit v3、MSTest 和 NUnit"
description: "SharpLsp 的 VS Code Test Explorer 现已支持 Microsoft.Testing.Platform 测试的发现、运行、调试和覆盖率收集，可并行处理 C# 与 F# 的 MTP 和 VSTest 项目。"
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
excerpt: "xUnit v3 4.0 仅支持 Microsoft.Testing.Platform。SharpLsp 现在可以同时处理 C# 和 F# 的 MTP 与 VSTest，支持发现、运行、调试和代码覆盖率。"
---

.NET 开发者使用的 `dotnet test` 正在发生变化。**Microsoft.Testing.Platform（MTP）** 是取代 **VSTest** 的新测试平台。测试项目会构建为一个可执行的 *测试模块*，自行发现并运行测试，不再需要单独的 `testhost` 进程或中间适配器。MSTest、NUnit 和 xUnit 都提供 MTP 运行器，而 **xUnit v3 4.0 仅支持 MTP v2**，完全不包含 VSTest 适配器。

因此，只支持 VSTest 的编辑器会为现代 xUnit v3 项目显示一棵 **空的测试树**。测试确实存在，`dotnet test` 也能运行，但编辑器看不到它们。

SharpLsp 的 Test Explorer 现在支持两者。实现已在 `main` 中，将随下一版本发布。它可以发现、运行、调试 MTP 模块并收集覆盖率，覆盖 **C# 和 F# 的 xUnit v3、MSTest 与 NUnit**，同时保留 VSTest 支持，包括混合两者的多根工作区。本文介绍：

- Microsoft.Testing.Platform 下的 `dotnet test` 如何工作；
- 如何在 C# 或 F# 项目中启用；
- Test Explorer 如何处理这些模块；
- 为确保可靠性而发现并修复的实际问题。

## 感谢 Valentin Dide

这项功能始于 **[Valentin Dide（@validide）](https://github.com/validide)** 遇到的空测试树。他提交了 [issue #249：“Microsoft.Testing.Platform (MTP) support in Test Explorer”](https://github.com/Nimblesite/SharpLsp/issues/249)，并进一步完成了实现。[PR #250：“Microsoft.Testing.Platform support in the Test Explorer”](https://github.com/Nimblesite/SharpLsp/pull/250) 添加了：

- MTP 检测；
- `--list-tests json` 发现；
- `--filter-uid` 运行；
- TRX 结果读取；
- MTP 模块的 Debug 配置；
- 覆盖两种语言及所有框架的六个端到端测试项目。

本文介绍的工作都建立在该 PR 之上。感谢 Valentin，这正是开源 .NET 工具通过协作不断改进的方式。

## MTP 与 VSTest 的区别

在 **VSTest** 下，`dotnet test` 构建项目，然后把程序集交给测试宿主。宿主加载框架 *适配器*（`xunit.runner.visualstudio`、`NUnit3TestAdapter`、`MSTest.TestAdapter`），再由适配器发现并运行测试。

在 **Microsoft.Testing.Platform** 下，测试项目本身就是运行器，会构建为具有独立命令行的可执行模块：

- `--list-tests` 用于列举；
- `--filter-uid` 用于选择；
- `--report-trx` 用于输出报告；
- `--coverage` 用于收集覆盖率。

TRX 和覆盖率属于 **扩展**：模块必须引用并注册对应的 NuGet 包，这些参数并非平台始终提供的能力。理解这一点，就能解释下面的大部分行为。

## 在 C# 和 F# 中启用

在 .NET 10 SDK 中，`dotnet test` 根据 `global.json` 选择模式：

```json
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

SharpLsp 也首先读取此设置。没有 `global.json` 的项目仍能被发现：SharpLsp 会通过 MSBuild 判断项目是否为 Testing Platform 应用，所以 VSTest 仓库中的 MTP 项目也能显示测试。

下面是使用 MTP 的 **C# xUnit v3** 项目：

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

**F# xUnit v3** 使用相同的项目设置，并加上 F# 所需的编译顺序：

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

对于 MTP 上的 **MSTest**，引用 `MSTest`（4.x）并设置 `<EnableMSTestRunner>true</EnableMSTestRunner>`。对于 **NUnit**，引用 `NUnit` 和 `NUnit3TestAdapter` 6.x，并设置 `<EnableNUnitRunner>true</EnableNUnitRunner>`。三者都需要 `<OutputType>Exe</OutputType>`，因为模块本身就是可执行程序。

xUnit v3 和 NUnit 还需要 **引用 `Microsoft.Testing.Extensions.TrxReport`**，MSTest 已自带。缺少它时，模块会拒绝 `--report-trx`，无法报告每项测试的结果。Test Explorer 会明确提示应添加哪个包，而不会显示一整片“未报告结果”。

## Test Explorer 如何处理 MTP 模块

**发现。** SharpLsp 先构建发现目标，再直接通过 `dotnet exec <module> --list-tests json` 查询各模块。它不经过 `dotnet test`，因为后者不会转发 `json` 参数（[dotnet/sdk#49754](https://github.com/dotnet/sdk/issues/49754)）。它能转发的文本列表只包含显示名，而 MSTest 的显示名只是方法名。

JSON 列表包含每项测试的命名空间、类型、方法及 **源码位置**，因此点击 MTP 测试行可以打开定义所在行。树形结构与 VSTest 一致：**Assembly → Namespace → Class → Test**。

Testing Platform 2.3 之前的模块不支持 JSON 列表。SharpLsp 会在日志和树中提示更新框架包。

**运行（▶）。** 每个模块为整组选中测试启动一次，而不是每项测试启动一次。包含二十项测试的类不会产生二十次进程启动。选择通过 `--filter-uid` 传递，这是验证矩阵中所有 MTP 框架都接受的过滤方式，值按字面传递，无需转义。对于 NUnit 的 `Adds_Case(2,2,4)` 这类 uid，这一点尤其重要。

结果通过 `--report-trx` 返回，并使用与 VSTest 相同的 TRX 读取器。成功、失败和跳过均来自真实结果，断言文本也由框架提供。xUnit `[Theory]`、MSTest `[DataRow]` 或 NUnit `[TestCase]` 在树中显示为一行，采用所有数据行中的 **最差结果**。

**代码覆盖率。** 如果模块引用 `Microsoft.Testing.Extensions.CodeCoverage`，Run with Coverage 会传入 `--coverage --coverage-output-format cobertura`。MTP 直接在结果目录中写入 `<guid>.cobertura.xml`，不同于 coverlet 在下一层目录中写入的 `coverage.cobertura.xml`。读取器会检查每个收集器实际使用的目录层级。

在 MTP 上使用 `dotnet test` 收集覆盖率，需要这个包和这组参数。模块缺少包时，提示会明确给出其名称。

**调试。** Debug 配置通过 `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` 启动模块。模块输出 PID 后等待，SharpLsp 将基于 netcoredbg 的调试器附加到该进程，测试体中的断点即可绑定并命中。Just My Code、本地变量和监视表达式正常工作，调试运行不会向测试树写入虚构的结果。

**同时使用 VSTest 和 MTP。** 运行器按发现目标选择，而非按工作区选择。多根工作区同时包含 VSTest 和 MTP 文件夹时，每项测试都交给发现它的运行器。每个 MTP 模块运行前，都会从自己的文件夹重新构建。

## F# 同样得到完整验证

SharpLsp 将 [F# 视为一等公民](/zh/blog/why-fsharp-is-first-class-in-sharplsp/)，所以每个 MTP 场景都同时使用 F# 和 C# 验证：

- ``` ``adds two numbers`` ``` 等 **包含空格的反引号名称** 会原样传入测试树、过滤器和调试器。
- **F# 模块** 编译为 CLR 类型，因此 `MyApp.Tests.Calculator` 显示为命名空间 `MyApp.Tests` → 类 `Calculator`，与 C# 类一致。
- **F# 的 `[<Theory>]` 数据行** 在同一 ID 下具有不同 uid。调试时，每行都会使用自己的 `[<InlineData>]` 参数停止一次。
- 同时包含空格和括号的 **NUnit `[<TestCase>]` 绑定** 会让 NUnit 拒绝自身对 `--filter-uid` 的过滤表达式转换。SharpLsp 检测到拒绝后，会不带过滤器重新运行模块一次，再按名称从报告中提取结果。
- **多目标 F# 模块**（`<TargetFrameworks>net9.0;net10.0</TargetFrameworks>`）配合 `#if NET9_0` 时，每个模块写入一份 TRX，所有框架的结果显示在同一个树根下。
- **将 F# 项目原地从 VSTest 迁移到 MTP** 会保留测试 ID 和测试树。SharpLsp 在下次刷新时读取 `global.json`，下一次 ▶ 即使用 MTP。
- `.fs` 文件中光标位置的 **Debug Test** 与 Testing 视图一样，会附加到等待中的 F# 模块。

## 为确保可靠性修复的问题

在演示项目中运行成功，还不足以保证实际项目中的行为正确。检查和加固过程中发现了以下缺陷，每个修复都先编写了能复现问题的端到端测试：

- **过期模块。** `dotnet exec` 不执行构建，因此会运行编辑前的测试。现在每次 MTP 运行都会先重新构建目标。
- **TRX 冲突。** 同一项目的两个目标框架生成同名模块，报告会相互覆盖。现在每次调用使用独立编号。
- **模块失败信息丢失。** 一个模块的整体失败可能被另一个模块的结果覆盖。现在会保留每个模块的失败信息。
- **排在刷新后面的运行使用旧运行器。** 项目刚迁移到 MTP，发现任务仍在队列中时点击 ▶，会使用 MTP 不接受的 `dotnet test --filter … --logger trx`。现在发现结果在其队列任务内应用，后续运行使用新发现的运行器。
- **带有 TRX 扩展的调试。** `Microsoft.Testing.Extensions.TrxReport` 的宿主控制器会用同一环境重新启动测试宿主。设置 `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` 后，两者都等待调试器。因此调试运行现在省略 `--report-trx`。
- **编辑数据行后错误地报告成功。** `--filter-uid` 使用模块自身的键，各框架生成方式不同：
  - **xUnit v3 对数据行内容进行哈希**，作为 uid；
  - **MSTest 按数据行的位置生成键**。

  添加数据行，或修改 xUnit 行的数据，会产生发现时不存在的 uid。使用旧 uid 过滤重新构建的模块，会遗漏刚刚修改的行，导致本应失败的测试显示成功。现在 SharpLsp 会在过滤运行前重新列举模块，选择本次构建实际包含的 uid。

## MTP 下的 xUnit、MSTest 与 NUnit

为新项目比较 **xUnit 与 MSTest** 或 **NUnit 与 xUnit** 时，从编辑器角度看，各框架在 Microsoft.Testing.Platform 上的差异如下：

| | xUnit v3 | MSTest | NUnit |
|---|---|---|---|
| VSTest 适配器 | 4.0 起不提供，仅支持 MTP | 有 | 有 |
| TRX 报告 | 添加 `Microsoft.Testing.Extensions.TrxReport` | 内置 | 添加 `Microsoft.Testing.Extensions.TrxReport` |
| `--list-tests json` 中的源码位置 | 有 | 有 | 无 |
| 数据行 uid | 行数据的哈希 | 按行位置生成 | 修饰名称，例如 `Adds_Case(2,2,4)` |
| 显示名 | 完全限定名称 | 仅方法名 | 带参数的方法名 |

这些差异并不意味着应该选择某个特定框架。它们说明 Test Explorer 不能根据显示名生成测试 ID，也不能相信上一次构建的 uid。

## 使用真实项目测试

MTP 支持由端到端测试覆盖，在真实的 VS Code 扩展宿主中构建实际 `.csproj` 和 `.fsproj` 文件：

- C# 和 F# 的 xUnit v3、MSTest 与 NUnit；
- 多目标模块；
- 缺少 TRX 或覆盖率扩展的模块；
- 超过单条命令行长度的测试选择；
- 混合 VSTest 与 MTP 的工作区；
- 排在刷新后面的运行；
- C# 和 F# 的真实断点调试；
- 在发现和 ▶ 之间修改或添加的数据行。

这些测试在 Windows 和 Linux CI 的独立任务中运行，与 VSTest 测试并行。

## 常见问题

**如何使用 Microsoft.Testing.Platform 运行 `dotnet test`？** 在 .NET 10 SDK 下，将 `"test": { "runner": "Microsoft.Testing.Platform" }` 加入 `global.json`，并使用支持 MTP 的框架包：xUnit v3、设置 `EnableMSTestRunner` 的 MSTest，或设置 `EnableNUnitRunner` 的 NUnit。

**xUnit v3 可以使用 VSTest 吗？** 从 4.0 开始不可以。`xunit.v3` 4.x 仅支持 MTP v2，不包含 VSTest 适配器。

**如何在 MTP 下过滤测试？** 各框架会添加自身的过滤选项。`--filter-uid` 属于平台本身，SharpLsp 的 ▶ 使用它，确保选择对应于选中的测试。

**如何在 MTP 的 `dotnet test` 中取得覆盖率？** 引用 `Microsoft.Testing.Extensions.CodeCoverage`，并传入 `--coverage --coverage-output-format cobertura`。SharpLsp Test Explorer 的 Run with Coverage 会完成这些操作。

**一个仓库能同时使用 VSTest 和 MTP 项目吗？** 可以。SharpLsp 按发现目标选择运行器，并将每项测试交给发现它的运行器。

## 试用

MTP 支持将随 0.21.0 之后的下一版 SharpLsp 发布。请关注[发布页面](https://github.com/Nimblesite/SharpLsp/releases)，或直接从 `main` 构建 VS Code 扩展。打开包含 MTP xUnit v3、MSTest 或 NUnit 项目的解决方案，然后打开 Testing 视图。如果出现空树、错误结果或无法附加的调试器，请[提交 issue](https://github.com/Nimblesite/SharpLsp/issues)。这项功能正是从这样的反馈开始的。
