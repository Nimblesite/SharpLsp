---
layout: layouts/docs.njk
title: 重构与代码操作
description: "SharpLsp 的 C# 与 F# 代码操作课程：Cmd+. 快捷键、按诊断划分的 F# 快速修复、生成 match 用例、跨文件重命名、Roslyn 修复，以及 resolve 的工作原理。"
lang: zh
eleventyNavigation:
  key: 重构与代码操作（中文）
  order: 7
---

<img src="/assets/screenshots/docs/refactoring.webp" alt="不完整的 F# match 上的快速修复：生成 1 个缺失的联合用例，以及添加通配符分支" width="2400" height="1500">

# 重构与代码操作

代码操作能把问题变成代码。本课程介绍快捷键、操作的来源、F# 修复、重命名和 C# 修复，最后讲解底层发生了什么，以及哪些功能不属于代码操作。这里的一切在 macOS、Linux 和 Windows 上都一样。

{% video "refactoring-lesson" %}

**你将学会：**

1. 用键盘打开代码操作菜单；
2. 预判菜单会提供哪些操作，以及原因；
3. 补全 F# match，并按诊断使用 F# 快速修复；
4. 跨文件重命名符号；
5. 根据调用生成 C# 方法，并添加缺失的 `using`；
6. 理解选中一个操作时 SharpLsp 做了什么。

**开始之前：** 安装 SharpLsp（[编辑器设置](/zh/docs/editors/)），并打开包含解决方案或项目的文件夹。代码操作由 C# 和 F# 编译器生成，因此需要先加载项目。

## 第 1 步：打开菜单

所有操作都从一个命令开始：**Quick Fix**。

| 位置 | 方式 |
|---|---|
| macOS 上的 VS Code | `Cmd+.` |
| Windows 和 Linux 上的 VS Code | `Ctrl+.` |
| 任何编辑器 | 点击边栏中的灯泡 |

其他编辑器也通过各自的代码操作命令提供同一个 LSP 请求。SharpLsp 对它们都以 `textDocument/codeAction` 响应。

## 第 2 步：了解操作的来源

操作依赖于上下文。边车进程只返回其编译器或提供程序能作用于光标处内容的修复和重构：

| 上下文 | 你会得到 |
|---|---|
| 诊断（警告或错误） | 该诊断的修复 |
| 光标位于类型、成员或表达式上 | 重塑它的重构 |
| 选区 | 作用于该范围的重构 |
| 空行或不支持的位置 | 没有操作。SharpLsp 从不瞎猜 |

所以当你期待的菜单没有出现时，把光标移到波浪线或符号上，或者选中代码，再试一次。

## 第 3 步：补全 F# match

在任何 F# 项目中都可以尝试。声明一个联合类型，以及一个漏掉一个用例的 match：

```fsharp
type Stage =
    | Browsing
    | CheckedOut of decimal

let describe stage =
    match stage with
    | Browsing -> "still browsing"
```

编译器会在 `stage` 下用 `FS0025`（模式匹配不完整）标出波浪线。把光标放在上面，按 `Cmd+.`，菜单会提供两个修复：

- **Generate 1 missing union case(s)** 为每个缺失的用例写出一个分支；
- **Add wildcard case** 则改为添加一个兜底的 `| _ ->` 分支。

选择 **Generate**：

```fsharp
let describe stage =
    match stage with
    | Browsing -> "still browsing"
    | CheckedOut _ -> failwith "todo"
```

F# 编译器知道联合类型的每一个用例，所以分支是精确的。你只需把 `failwith "todo"` 换成函数体。

## 第 4 步：按诊断划分的 F# 修复

每个 F# 修复都对应一条编译器诊断，或光标处的代码：

| 触发条件或上下文 | 操作 |
|---|---|
| `FS0039` | 能识别命名空间时，添加用于解析的 `open` |
| `FS1182` | 给未使用的绑定加上 `_` 前缀 |
| `FS0020` | 添加 `|> ignore` |
| `FS0025` | 添加通配符 match 分支 |
| `FS0026` | 移除冗余模式 |
| 受支持的 `FS0001` 类型不匹配 | 插入已知转换 |
| 可区分联合的 match | 生成缺失的用例 |
| 记录表达式 | 生成缺失的字段 |
| 接口实现 | 生成成员存根 |
| `SLSPF0102` / `SLSPF0103` | 移除未使用的 `open`／简化名称 |

只有当项目启用了该警告时，F# 编译器才会报告 `FS1182`，例如在项目文件中写入 `<OtherFlags>--warnon:1182</OtherFlags>`。

**试一试：** 在单独一行写下 `List.map (fun x -> x + 1) [1; 2]`。因为结果被丢弃，编译器会警告 `FS0020`。按 `Cmd+.` 会提供 `|> ignore`。

编译器拼写纠正和部分 FSAC 操作尚未实现；请参阅 [F# 语言支持](/zh/docs/fsharp/)。

## 第 5 步：跨文件重命名

重命名不是代码操作。把光标放在符号上，按 `F2`（**Rename Symbol**），输入新名字，然后按 `Enter`。SharpLsp 提供 `textDocument/prepareRename`，让编辑器事先知道该符号能否重命名，随后由 `textDocument/rename` 编辑所有引用：

- C# 重命名使用已加载的 Roslyn 解决方案；
- F# 重命名使用已加载的 F# 项目，并编辑所有使用该符号的文件。

在课程中，把 `Sessions.fs` 里的 F# 函数 `remember` 重命名为 `rememberOrder`，`Program.fs` 中的调用也会随之改写。

## 第 6 步：根据调用生成 C# 方法

C# 边车进程从内置的 Roslyn 功能程序集中发现 Roslyn 的代码修复和重构提供程序，所以 C# 修复就是 Roslyn 自己的修复。一个好用的习惯是先写调用：

```csharp
var receipt = Receipt(invoice);
```

`Receipt` 还不存在，所以编译器报错。在它上面按 `Cmd+.`，会提供 **Generate method 'Receipt'**，Roslyn 会根据调用确定参数类型并写出存根：

```csharp
private object Receipt(string invoice)
{
    throw new NotImplementedException();
}
```

## 第 7 步：添加缺失的 `using`

在没有命名空间的情况下使用一个类型：

```csharp
var builder = new StringBuilder();
```

在 `StringBuilder` 上按 `Cmd+.`，第一项就是 `using System.Text;`。下面还有完全限定名、生成新的 `StringBuilder` 类，以及该位置可用的其他 Roslyn 重构，例如转换为块范围命名空间。

其他经过验证的 C# 操作包括删除未使用的局部变量，以及针对有效类型或选区的 Roslyn 重构。具体列表会随语法、诊断、Roslyn 版本和可用的提供程序而变化。某个类别存在，并不代表 Visual Studio 的所有重构都可用。

## 底层原理：先列出，再解析

一个代码操作需要两个请求：

1. **询问。** 编辑器针对光标或选区发送 `textDocument/codeAction`。
2. **列出。** 边车进程（C# 用 Roslyn，F# 用 F# 编译器）返回不含编辑的轻量项目：标题和类型。这让菜单保持快速。
3. **解析。** 当你选中一项时，`codeAction/resolve` 只为该操作计算编辑。
4. **应用。** 结果是一个工作区编辑，可以同时修改多个现有文档。

如果操作已过期、边车进程已重启，或者提供程序无法生成编辑，resolve 会返回空编辑，而不是瞎猜。

## 哪些不是代码操作

- **格式化。** SharpLsp 有意不提供 LSP 格式化。C# 请使用 [CSharpier](https://csharpier.com/)，F# 请使用 [Fantomas](https://fsprojects.github.io/fantomas/)。
- **Sort Members。** 一个基于 tree-sitter 的独立 C# 命令。在解决方案资源管理器中右键点击一个 C# 类型并选择 **Sort Members**，它会按配置的可访问性、类别和名称对成员排序。
- **重命名。** 即第 5 步中的 `F2`。

## 回顾

- `Cmd+.`（或 `Ctrl+.`）会打开适用于光标、选区或诊断的所有操作。
- F# 修复跟随编译器诊断，能写出完整的 match 用例、记录字段和接口存根。
- `F2` 可以在 F# 和 C# 中跨文件重命名。
- 在 C# 中，先写调用，再生成方法。

## 一镜到底的演示

同样的功能，在 VS Code 中一次连续录制：

{% video "refactoring" %}
