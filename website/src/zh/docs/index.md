---
layout: layouts/docs.njk
title: 快速入门
lang: zh
eleventyNavigation:
  key: 快速入门（中文）
  order: 1
---

# SharpLsp 快速入门

SharpLsp 是一个用 Rust 构建的开源 .NET 语言服务器协议（LSP）实现，支持 C# 和 F#。一个服务器，每款编辑器。目标是与 Visual Studio、Rider 和 C# Dev Kit 达到完整的功能对等——零专有依赖，零许可证，零供应商锁定。

## 安装

### VS Code

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) 安装 SharpLsp 扩展。

扩展在 VSIX 内附带 `sharplsp` 二进制文件和两个 sidecar。无需 Rust 工具链，无需单独安装二进制。打开 `.sln` 或 `.csproj`，SharpLsp 会自动启动。

<section class="callout">
  <h2><span class="material-symbols-outlined" aria-hidden="true">deployed_code</span>前提条件</h2>
  <ul class="requirement-list">
    <li><span class="material-symbols-outlined" aria-hidden="true">deployed_code</span><div><h3>.NET 10.0 SDK</h3><p>用于项目解析和 MSBuild 集成。请确保 <code>dotnet</code> 在您的 PATH 中。</p></div></li>
  </ul>
</section>

### Neovim 与 Zed

Neovim 与 Zed 支持即将推出。

<p class="next-link"><a href="/zh/docs/architecture/">下一节：架构 <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span></a></p>
