---
layout: layouts/docs.njk
title: F# 性能分析
description: "用 SharpLsp 在 VS Code 中分析 F# 的 CPU 和内存：.fs 行上的热力条、按名称显示的闭包和管道阶段、标在构造位置的记录和联合用例，以及追溯到持有泄漏的模块值。"
lang: zh
eleventyExcludeFromCollections: true
---

# F# 性能分析

SharpLsp 的[性能分析器](/zh/docs/profiler/)附加到 .NET 运行时，而不是某种语言，因此 F# 程序能得到 C# 程序拥有的一切：热点行上的热力条、火焰图、实时堆时间线和排好序的可疑泄漏。它还能读懂 F# 编译器生成的代码：

- **闭包和管道阶段**保留编译器给它们的名称，因此热点阶段会指向它所在的行。
- **记录、联合和联合用例**标在构造它们的行上，因为编译器为这些类型生成的成员没有自己的源代码行。
- **由模块值持有的泄漏**会以源代码中的写法给出该值的名称。

下面是在 FsStorefront（C# Storefront 演示的 F# 版本）上完整流程的录像，在 VS Code 中录制。快进的片段在画面上有标注：

{% video "profiler-fsharp" %}

FsStorefront 不停地处理订单结账：解析 CSV 商品目录、挑选购物篮、计算价格，并用 `sprintf` 生成发票。它还把每个客户会话都保存在一个模块级的 `Dictionary` 中，而这个字典从不清空。

## 分析 F# 代码的 CPU

在 **Processes** 视图中将鼠标悬停在应用所在行上并点击 **Profile CPU**，或运行 **SharpLsp: Start Profiling**。让慢路径运行一段时间，然后点击 **Stop Profiling**。`.fs` 文件中的每个热点行都会得到一个热力条，显示它所占的样本比例。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-fsharp-heatmap.webp" alt="Checkout.fs 中 F# 程序的 CSV 解析、购物篮洗牌和折扣行上带有热力条" width="2400" height="1500">
  <figcaption><code>Checkout.fs</code> 中的热力图。热点行是 CSV 解析管道、购物篮洗牌和折扣的 fold。</figcaption>
</figure>

结果面板和火焰图按编译器生成的名称显示每一帧：

| F# 代码 | 结果中的显示 |
|---|---|
| 模块函数 `let toProduct line = …` | `FsStorefront.Checkout.toProduct`：依次为命名空间、模块和函数 |
| 第 24 行的 lambda `fun p -> sprintf …` | `Checkout+lines@24.Invoke`：它绑定到的值及其行号 |
| 第 11 行的管道阶段 `… \|> Array.choose toProduct` | `Checkout+Pipe #1 stage #1 at line 11@11.Invoke` |
| `inline` 函数 | 没有帧：编译器把函数体复制到每个调用方，所以它的时间计入调用方 |
| `List.map`、`Seq.fold` 等 FSharp.Core 函数 | `Microsoft.FSharp.Collections.ListModule.Map` 等 |

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-fsharp-results.webp" alt="F# 程序的 SharpLsp Profiler 结果面板，包含火焰图，以及按模块、闭包和管道阶段命名的热点函数" width="2400" height="1500">
  <figcaption>结果面板。每个闭包和管道阶段都以它所在的行命名。</figcaption>
</figure>

请分析你实际发布的构建。Debug 构建为每次调用保留一个帧。Release 构建会内联小函数，F# 编译器还会生成尾调用，因此以调用另一个函数结束的函数可能不会出现在其下方的调用栈中。

## 分析 F# 代码的内存

点击该行的 **Track Memory**，或运行 **SharpLsp: Start Memory Tracking**。**SharpLsp Memory Dashboard** 会在代码旁打开，显示堆时间线、主要分配位置和可疑泄漏。用 `sharplsp.profiler.autoSnapshot` 打开定时快照后，仪表板会对持续增长的类型进行排序。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-fsharp-leaks.webp" alt="内存仪表板将 F# 记录和联合用例列为可疑泄漏，旁边的 Sessions.fs 在构造它们的行上带有紫色热力条" width="2400" height="1500">
  <figcaption>FsStorefront 中的可疑泄漏。记录和联合用例被标在 <code>Sessions.fs</code> 中构造它们的行上。</figcaption>
</figure>

### F# 类型标在哪里

C# 类标在它的声明处。F# 编译器为记录或联合生成的成员都没有源代码行，因此 SharpLsp 把这些类型标在程序中构造它们的行上：

| 类型 | 标注位置 | 仪表板中的名称 |
|---|---|---|
| 记录 `{ Order = order; Stage = stage; … }` | 构造它的行 | `FsStorefront.CustomerSession` |
| 带字段的联合用例 `CheckedOut order.Total` | 构造它的行 | `FsStorefront.Stage+CheckedOut`：每个带字段的用例都是嵌套在其联合中的类 |
| 单用例联合 `CustomerId 42` | 构造它的行 | `FsStorefront.CustomerId` |
| 泛型记录 | 构造它的行 | 带上类型参数，例如 ``Tagged`1[System.Int32]`` |
| 闭包或匿名记录 | 构造它的行 | 编译后的名称 |
| 有自己成员的类 | 它的第一个成员 | `FsStorefront.PriceTicker` |
| 结构体记录或结构体联合（`[<Struct>]`） | 不标注：它存储在持有它的对象内部，不会单独出现 | 不列出 |
| 不带字段的联合用例，例如 `Browsing` | 不标注：每次使用都共享同一个实例，所以不会增长 | 不列出 |
| 数组、F# 列表以及其他 FSharp.Core 和框架类型 | 不标注：它们在你的项目中没有源代码 | 只显示名称，例如 ``FSharpList`1[FsStorefront.Product]`` |

点击仪表板上的可疑项即可跳转到它的行。

### 是什么让它一直存活：模块值

运行 **SharpLsp: Show Reference Graph** 并选择可疑类型，即可看到持有它的对象，以及让这些对象一直存活的根。像 `let private sessions = Dictionary<int, CustomerSession>()` 这样的模块值会被编译成一个以行号命名的静态字段 `sessions@6`。保留图把这个根标为 `static sessions`，与你写的一致。

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-fsharp-graph.webp" alt="FsStorefront.CustomerSession 的保留图：会话由一个 Dictionary 持有，根是模块值 static sessions" width="2400" height="1500">
  <figcaption>每个 <code>CustomerSession</code> 都挂在同一个 <code>Dictionary</code> 上，根是模块值 <code>sessions</code>。</figcaption>
</figure>

FsStorefront 只需要最近的会话，所以修复方法是只保留最近 1,000 个：

```fsharp
// Remembers the last 1,000 orders "for analytics", and forgets older ones.
let private sessions = Dictionary<int, CustomerSession>()

let remember order =
    let stage = CheckedOut order.Total
    sessions[order.Id] <- { Order = order; Stage = stage; Snapshot = Array.zeroCreate 4096 }
    sessions.Remove(order.Id - 1_000) |> ignore
```

重新构建并再次跟踪后，堆趋于平稳，没有任何可疑项升到 Low 以上。[如何修复内存泄漏](/zh/docs/memory-leaks/)完整讲解了这一流程，包括事件处理程序和闭包的 F# 修复方法，以及 F# 泄漏测试。

## 相关内容

- [性能分析器](/zh/docs/profiler/)：所有性能分析器命令和设置
- [如何修复内存泄漏](/zh/docs/memory-leaks/)：用 C# 和 F# 逐步修复泄漏
- [F# 语言支持](/zh/docs/fsharp/)：SharpLsp 为 F# 提供的其他一切
