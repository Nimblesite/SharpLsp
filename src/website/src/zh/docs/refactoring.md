---
layout: layouts/docs.njk
title: 重构与代码操作
description: "在 SharpLsp 中使用 C# 与 F# 快速修复：添加导入、生成缺失代码、转换 F# 管道，以及把 C# 类型移动到独立文件。"
lang: zh
eleventyNavigation:
  key: 重构与代码操作（中文）
  order: 7
---

<img src="/assets/screenshots/docs/refactoring.webp" alt="不完整的 F# match 上的快速修复" width="2400" height="1500">

# 重构与代码操作

打开解决方案或项目，等待加载完成后，把光标放在错误或声明上。macOS 上按 **Cmd+.**，Windows 和 Linux 上按 **Ctrl+.** 即可打开 Quick Fix。其他 LSP 编辑器则通过各自的代码操作菜单提供这些操作。

{% video "refactoring-lesson" %}

## F# 快速修复

| 上下文 | 操作 |
|---|---|
| 未解析名称（`FS0039`） | 添加可解析的 `open`、限定该处使用，或添加适用的 `open type` |
| 未使用绑定（`FS1182`） | 为名称添加 `_` 前缀 |
| 丢弃了结果（`FS0020`） | 添加 `\|> ignore` |
| 模式匹配不完整（`FS0025`） | 生成缺失的联合用例或添加通配符分支 |
| 冗余模式（`FS0026`） | 移除该模式 |
| 受支持的类型不匹配（`FS0001`） | 插入已知转换 |
| 记录表达式 | 生成缺失的字段 |
| 接口实现 | 生成成员存根 |
| 未使用的 `open` 或限定名称 | 移除导入或简化名称 |

例如，把光标放在下面这个不完整的 match 上，选择 **Generate 1 missing union case(s)**。

```fsharp
type Stage = Browsing | CheckedOut of decimal

let describe stage =
    match stage with
    | Browsing -> "still browsing"
```

SharpLsp 会添加 `| CheckedOut _ -> failwith "todo"`。把生成的函数体替换成你自己的实现即可。

对于受支持的单行表达式，菜单还可以在 `g a (f x)` 和 `x |> f |> g a` 之间相互转换。可用操作取决于编译器诊断和光标下的代码。当前覆盖范围请参阅 [F# 语言支持](/zh/docs/fsharp/)。

## 选择导入

导入修复会在应用之前说明将要进行的修改。

| 意图 | F# | C# |
|---|---|---|
| 导入命名空间 | `open System.Text` | `using System.Text;` |
| 限定单处使用 | `System.Text.StringBuilder` | `System.Text.StringBuilder` |
| 只导入一个类型 | 使用其限定名称 | `using StringBuilder = System.Text.StringBuilder;` |
| 导入静态成员和嵌套类型 | `open type System.Math` | `using static System.Math;` |

可以在 F# 中试试 `let builder = StringBuilder()`，或在 C# 中试试 `var builder = new StringBuilder();`，且不导入 `System.Text`。在 `StringBuilder` 上打开 Quick Fix，即可看到适用的选项。F# 的 `open type` 需要 F# 5 或更高版本。

对于受支持的未解析类型，菜单还可以添加对解决方案中另一个同语言项目或 NuGet 包的引用。标题会写明引用和导入。包候选项来自解决方案中已在使用的包，或 SharpLsp 受支持的包列表。

## 生成 C# 代码

先写一个对尚不存在的方法的调用，然后在方法名上打开 Quick Fix。**Generate method** 会根据调用推断参数类型并创建存根。Roslyn 会针对当前语法和选区提供 C# 修复和重构。

## 移动 C# 类型

在声明的名称上打开 Quick Fix。

| 操作 | 结果 |
|---|---|
| **Move type to Receipt.cs** | 在源文件旁边创建一个新文件，保留命名空间、导入、文档和特性 |
| **Move 'Inner' out of 'Outer' to Inner.cs** | 把嵌套类型提升为顶层类型，并更新整个解决方案中的引用 |
| **Rename file to Receipt.cs** | 将文件重命名为与其类型一致 |

普通移动会让嵌套类型在部分（partial）容器声明之间保持嵌套。移出操作会检查名称冲突、已存在的目标文件，以及对不可访问容器成员或外围类型参数的依赖。把私有嵌套类型移出后会变为 `internal`。

## 应用操作

选择一个操作会计算它的编辑，这些编辑可能涉及多个文件。如果操作已过期或无法应用，SharpLsp 会说明原因。引用类操作会先应用导入，再添加引用；如果添加引用失败，错误信息会说明撤销操作会同时移除该导入。

符号重命名请按 **F2**。格式化方面，C# 请安装 [CSharpier](https://csharpier.com/)，F# 请安装 [Fantomas](https://fsprojects.github.io/fantomas/)。

{% video "refactoring" %}
