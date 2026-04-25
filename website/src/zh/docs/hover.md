---
layout: layouts/docs.njk
title: 悬停与快速信息
lang: zh
eleventyExcludeFromCollections: true
---

**VS Code**
![VS Code 中的悬停](/assets/screenshots/vscode-hover-page.png)

**Zed**
![Zed 中的悬停](/assets/screenshots/zed-hover-page.png)

*悬停显示完整的 XML 文档、类型签名和可空性注释。*

# 悬停与快速信息

将鼠标悬停在任何符号上，查看其完整的类型签名、XML 文档、参数描述、可空性注释和弃用通知。Forge 为 C# 和 F# 实现了 `textDocument/hover`（LSP 3.17），两者都是同等一流的公民。

## 显示内容

当你悬停在符号上时，Forge 返回一个 Markdown 渲染的工具提示，包含：

| 部分 | 内容 |
|---------|---------|
| **签名** | 带有语法高亮的完全限定符号签名 |
| **包含类型** | 成员的 `ContainingType.Name` |
| **XML 文档** | `<summary>`、`<param>`、`<returns>`、`<remarks>`、`<example>` |
| **异常** | XML 文档中的 `<exception>` 标签 |
| **可空性** | 可空注释状态 |
| **可访问性** | `public`、`internal`、`protected` 等 |
| **弃用** | 带警告的 `[Obsolete]` 消息 |

## C# 悬停（Roslyn）

C# sidecar 通过 `SemanticModel.GetSymbolInfo()` 解析符号，并按优先级从三个来源渲染 XML 文档：

1. 源代码 `///` 注释
2. NuGet 包中的 XML 文档文件（与程序集一起的 `.xml` 文件）
3. Roslyn 内置文档提供程序

### 特殊情况

| 悬停目标 | 行为 |
|--------------|---------|
| `var` 关键字 | 显示推断类型及完整签名 |
| `await` 表达式 | 显示解包的 `Task<T>` 返回类型 |
| `nameof(Foo)` | 显示引用的符号 |
| 字符串字面量 | 返回 `null`（无工具提示）|
| Lambda 参数 | 显示推断的参数类型 |
| 元组元素 | 显示元素名称和类型 |
| 模式变量 | 显示模式匹配的类型 |
| `[Obsolete]` 成员 | 显示弃用消息 |

### 示例

```csharp
var result = Enumerable.Range(0, 10).Select(x => x * x).ToList();
//           ↑ 悬停显示：
// IEnumerable<int> Enumerable.Range(int start, int count)
// 生成指定范围内的整数序列。
// 参数：
//   start：序列中第一个整数的值。
//   count：要生成的连续整数数量。
```

## F# 悬停（FSharp.Compiler.Service）

F# sidecar 通过 `FSharpCheckFileResults.GetToolTip()` 解析符号，并将 `ToolTipElement` 结构渲染为 Markdown。XML 文档通过与 C# sidecar 共用的 `XmlDocRenderer` 渲染。

### F# 特有情况

| 悬停目标 | 行为 |
|--------------|---------|
| 判别联合案例 | 显示带类型的案例字段 |
| 记录字段 | 显示字段类型和包含记录 |
| 管道运算符（`\|>`、`>>`）| 显示推断的函数类型 |
| 活动模式 | 显示模式签名和文档 |
| 计算表达式关键字（`let!`、`do!`、`return!`）| 显示 CE 构建器方法 |
| 类型提供程序 | 显示提供的类型及其属性 |
| 度量类型 | 显示度量单位注释 |

### 示例

```fsharp
let result = [1..10] |> List.map (fun x -> x * x) |> List.sum
//                       ↑ 悬停显示：
// val map: mapping: ('T -> 'U) -> list: 'T list -> 'U list
// 构建一个新集合，其元素是将给定函数应用于集合每个元素的结果。
```

## 解决方案资源管理器悬停

解决方案资源管理器树视图使用与代码编辑器**相同的悬停管道**。当你悬停在树中的符号上时，工具提示与代码编辑器中显示的完全相同。

| 树节点类型 | 工具提示来源 |
|---|---|
| 符号（类、方法、属性等）| LSP 悬停 — 与代码编辑器相同 |
| 命名空间 | LSP 悬停 — 与代码编辑器相同 |
| NuGet 包 | 包名称 + 版本 |
| 项目引用 | 引用名称 |

## 缓存

悬停结果由 Rust 宿主通过 [salsa](https://salsa-rs.github.io/salsa/) 增量计算缓存。

| 缓存键 | 失效时机 |
|-----------|-----------------|
| `(document_uri, document_version, position)` | 文档被编辑时 |

缓存命中在 1ms 内返回。过时的悬停请求（针对超级版本的文档）会立即取消。

## 性能目标

| 指标 | 目标 |
|--------|--------|
| 悬停延迟（p50） | <150ms |
| 悬停延迟（p95） | <300ms |
| 缓存位置 | <1ms |
| Tree-sitter 预验证（跳过空白）| <1ms |

## 错误处理

悬停永远不会返回错误或阻塞编辑器。任何失败时 — sidecar 未就绪、符号解析失败、IPC 超时 — Forge 返回 `null`（无工具提示）。Sidecar 崩溃在 3 秒内触发自动恢复。

## 竞品对比

| 功能 | Visual Studio | C# Dev Kit | Rider | **Forge** |
|---------|:---:|:---:|:---:|:---:|
| 基本符号悬停 | ✓ | ✓ | ✓ | ✓ |
| XML 文档 | ✓ | ✓ | ✓ | ✓ |
| `var` 推断类型 | ✓ | ✓ | ✓ | ✓ |
| NuGet XML 文档 | ✓ | ✓ | ✓ | ✓ |
| 异常文档 | ✓ | ✗ | ✓ | ✓ |
| 可空注释显示 | ✓ | ✓ | ✓ | ✓ |
| 弃用警告 | ✓ | ✓ | ✓ | ✓ |
