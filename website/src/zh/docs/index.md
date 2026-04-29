---
layout: layouts/docs.njk
title: 快速入门
lang: zh
eleventyNavigation:
  key: 快速入门（中文）
  order: 1
---

# Getting Started with SharpLsp

SharpLsp 是一款开源、编辑器无关的 .NET 语言服务器，为 VS Code、Neovim、Helix、Emacs、Zed 及任何支持 LSP 的编辑器提供完整的 C# 和 F# 开发体验。安装一次服务器，随处享受完整的 .NET 工具链。

<img src="/assets/screenshots/vscode-getting-started-page.png" alt="" aria-hidden="true" style="position:absolute;width:1px;height:1px;opacity:0;margin:0;border:0;">

<section class="callout">
  <h2><span class="material-symbols-outlined" aria-hidden="true">fact_check</span>前提条件</h2>
  <ul class="requirement-list">
    <li>
      <span class="material-symbols-outlined" aria-hidden="true">deployed_code</span>
      <div>
        <h3>.NET 10.0 SDK</h3>
        <p>用于项目加载、MSBuild 集成和语义分析。请从 <a href="https://dotnet.microsoft.com/download">microsoft.com/download</a> 下载，并确保 <code>dotnet</code> 在您的 PATH 中。</p>
      </div>
    </li>
  </ul>
</section>

## 安装

### VS Code

从 VS Code Marketplace 安装 SharpLsp 扩展，或从源码构建：

```sh
make build-vsix
code --install-extension sharplsp.vsix
```

扩展会自动管理 SharpLsp LSP 服务器的生命周期，无需额外配置。

### 其他编辑器

从 [GitHub Releases 页面](https://github.com/Nimblesite/SharpLsp/releases) 下载 `sharplsp` 二进制文件并放入 PATH，然后参阅[编辑器配置](/zh/docs/editors/)指南。

## 基本用法

<div class="usage-grid">
  <section class="usage-card">
    <h3><span class="material-symbols-outlined" aria-hidden="true">folder_open</span>打开解决方案</h3>
    <p>打开包含 <code>.sln</code>、<code>.slnx</code>、<code>.csproj</code> 或 <code>.fsproj</code> 文件的目录，SharpLsp 将自动检测并加载项目。</p>
  </section>
  <section class="usage-card">
    <h3><span class="material-symbols-outlined" aria-hidden="true">play_arrow</span>开始开发</h3>
    <p>代码补全、诊断、跳转到定义、悬停提示、重构、NuGet 管理和性能分析功能立即可用，无需额外配置。</p>
  </section>
</div>

<p class="next-link"><a href="/zh/docs/architecture/">Next: Architecture <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span></a></p>
