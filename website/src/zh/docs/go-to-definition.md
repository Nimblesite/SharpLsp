---
layout: layouts/docs.njk
title: 跳转到定义
lang: zh
eleventyExcludeFromCollections: true
---

![VS Code 中的跳转到定义](/assets/screenshots/vscode-go-to-definition-page.png)

*Alpha 版 VS Code 扩展中的 C# 定义导航。*

# 跳转到定义

SharpLsp 正在基于 Roslyn sidecar 构建 LSP 定义导航请求家族。当前扩展展示 VS Code 工作流，边界情况仍在继续加固。

## 导航方法

| LSP 方法 | 快捷键（VS Code）| 描述 |
|------------|-------------------|-------------|
| `textDocument/definition` | `F12` | 导航到符号的声明 |
| `textDocument/typeDefinition` | `Ctrl+F12` | 导航到符号的类型 |
| `textDocument/declaration` | — | 导航到接口/抽象声明 |
| `textDocument/implementation` | `Ctrl+Shift+F12` | 导航到所有具体实现 |

定义导航是 SharpLsp 的发布阻断领域。Alpha 阶段请针对你依赖的具体操作和项目结构验证行为。

## C# 导航（Roslyn）

### textDocument/definition

Roslyn 通过 `SemanticModel.GetSymbolInfo()` 解析符号，并从 `ISymbol.Locations` 返回源位置。

### textDocument/implementation

使用 `SymbolFinder.FindImplementationsAsync()` 在整个解决方案中定位所有具体实现。当存在多个实现时（例如，有十个实现类的接口），返回 `Location[]`。

### 特殊情况

| 符号 | `definition` | `typeDefinition` | `declaration` | `implementation` |
|--------|-------------|-----------------|---------------|-----------------|
| 变量（`var x = new Foo()`）| 变量声明 | `Foo` 类 | 与 definition 相同 | — |
| 方法调用（`bar.Baz()`）| 方法体 | 返回类型 | 接口/抽象方法 | 所有重写 |
| 接口成员 | 接口声明 | 成员返回类型 | 相同 | 所有实现类 |
| 重写方法 | 重写位置 | 返回类型 | 基虚拟/抽象方法 | 所有同级重写 |
| 构造函数（`new Foo()`）| 构造函数声明 | `Foo` 类 | 相同 | — |
| 分部类/方法 | 第一个 `partial` 声明 | 类型 | 定义分部 | 所有分部 |

### 反编译源码导航

当符号定义在引用的程序集（NuGet 包、BCL）中时，SharpLsp 使用 [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy) 按需反编译包含类型。反编译的源码在只读缓冲区中打开，即使对框架内部也能完整导航。

```csharp
// Ctrl+单击 List<T>.Add() 导航到反编译内容：
// public void Add(T item) {
//     if (_size == _items.Length) EnsureCapacity(_size + 1);
//     _items[_size++] = item;
//     _version++;
// }
```

## 缓存

所有定义结果通过 salsa 以键 `(document_uri, version, position, method)` 缓存。缓存命中在 1ms 内返回。`method` 组件区分同一位置的 `definition`、`typeDefinition`、`declaration` 和 `implementation`。

## 性能目标

| 指标 | 目标 |
|--------|--------|
| 定义延迟（p50） | <100ms |
| 定义延迟（p95） | <250ms |
| 缓存定义 | <1ms |
| 查找实现（100 个实现） | <500ms |
