---
layout: layouts/docs.njk
title: 快速入门
lang: zh
eleventyNavigation:
  key: 快速入门（中文）
  order: 1
---

# SharpLsp 快速入门

SharpLsp 是一个面向 .NET 的开源语言服务器协议实现，由一个 Rust 宿主承载 C# 和 F# 语义引擎。项目正在努力实现媲美 Visual Studio 和 Rider 的工具体验，同时不依赖专有语言服务，也不按席位收费。SharpLsp 仍处于积极开发阶段，目前受支持的编辑器集成是 VS Code。

## 安装

### VS Code

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) 安装 SharpLsp 扩展。

VSIX 内含 `sharplsp` 宿主和两个 .NET sidecar。你不需要 Rust 工具链，也不必单独安装 SharpLsp 二进制文件。打开包含 `.sln`、`.slnx`、`.csproj` 或 `.fsproj` 的工作区，扩展就会启动服务器。

<section class="callout">
  <h2>自动配置 .NET</h2>
  <ul class="requirement-list">
    <li><span class="requirement-icon" aria-hidden="true">.NET</span><div><h3>.NET 10 SDK</h3><p>SharpLsp 需要 SDK 来运行 MSBuild 和编译器服务。激活时，扩展会查找兼容的 SDK，或要求 Microsoft 的 .NET Install Tool 获取一个。语言服务和 F# Interactive 可以使用该 SDK，无需事先将 <code>dotnet</code> 放入 PATH；但构建／测试命令和部分 NuGet 操作仍会按名称启动 <code>dotnet</code>，因此要求它位于 PATH 中。</p></div></li>
  </ul>
</section>

当前版本包含 C# 和 F# 代码补全、悬停信息、导航、诊断、符号、代码操作、重命名、语义令牌、内联提示、解决方案工具、NuGet 工作流、调试和性能分析。部分功能仍不完整；各功能页面记录了它们目前的限制。

### 其他编辑器

服务器会尽可能使用标准 LSP，但 Neovim、Zed、Rider、Helix 和 Emacs 的打包集成尚未发布。

<p class="next-link"><a href="/zh/docs/architecture/">下一节：架构 <span aria-hidden="true">→</span></a></p>
