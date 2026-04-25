---
layout: layouts/docs.njk
title: 代码补全
lang: zh
eleventyNavigation:
  key: 代码补全（中文）
  order: 4
---

![VS Code 中的代码补全](/assets/screenshots/vscode-completions-page.png)

*由 Roslyn 驱动的完整 IntelliSense 补全 — 与 Visual Studio 相同的引擎。*

# 代码补全

Forge 为 C# 提供 IntelliSense 质量的代码补全，由完整的 Roslyn API 驱动。补全通过 C# sidecar 路由，使 Rust 宿主专注于快速语法操作。

## 性能目标

| 指标 | 目标 |
|--------|--------|
| p50 延迟 | <100ms |
| p95 延迟 | <200ms |
| 缓存（未变更文档） | <1ms |

## C# 补全（Roslyn）

C# sidecar 使用 Roslyn 的 `CompletionService` 生成补全。这与 Visual Studio 提供完全相同的结果 — 相同的引擎，相同的 API，零近似。

### 补全内容

- **类型和命名空间** — 类、接口、结构体、枚举、委托
- **成员** — 方法、属性、字段、事件、索引器
- **关键字** — 所有 C# 关键字，带有正确的上下文过滤
- **代码片段** — 常见代码模式（`for`、`foreach`、`if`、`try` 等）
- **导入补全** — 来自引用程序集的未导入类型
- **重写补全** — 要实现的抽象/虚拟成员
- **XML 文档补全** — `///` 触发器补全 `<summary>`、`<param>` 等
- **`var` 推断** — 在补全工具提示中显示推断类型

### 触发字符

补全在以下字符之后自动触发：

| 字符 | 上下文 |
|-----------|---------|
| `.` | 成员访问 |
| `(` | 参数提示 |
| `<` | 泛型类型参数 |
| `[` | 数组索引器、属性 |
| `{` | 对象初始化器 |
| ` ` | 关键字补全 |
| `@` | 逐字标识符 |

### 导入补全

尚未 `using` 导入的类型会以灰色指示器显示在补全列表中。选择一个后会自动在文件顶部添加正确的 `using` 指令。

```csharp
// 之前：没有 JsonSerializer 的 using
var json = JsonSerializer.Serialize(obj);
//         ↑ 补全添加：using System.Text.Json;
```

## 配置

```toml
# forge.toml
[completions]
# 显示未引用程序集中的类型（需要 NuGet 还原）
import_completions = true

# 每次请求返回的最大结果数
max_results = 200

# 触发补全前的最小字符数
min_trigger_length = 0
```

## LSP 协议

Forge 广播：

```json
{
  "completionProvider": {
    "resolveProvider": true,
    "triggerCharacters": [".", "(", "<", "[", "{", " ", "@"]
  }
}
```

`completionItem/resolve` 受支持 — 完整文档和附加编辑（例如，导入插入）在解析时添加，保持初始列表的快速响应。
