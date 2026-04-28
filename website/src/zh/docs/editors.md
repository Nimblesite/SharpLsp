---
layout: layouts/docs.njk
title: 编辑器配置
lang: zh
eleventyNavigation:
  key: 编辑器配置（中文）
  order: 3
---

# 编辑器配置

![VS Code 中的 Forge 编辑器支持](/assets/screenshots/vscode-editors-page.png)

Forge 在 LSP 层面以编辑器无关为目标，但当前 alpha 网站反映的是 VS Code 扩展。其他编辑器集成存在于仓库中或仍处于实验阶段。

## VS Code

从应用商店安装 Forge 扩展，或从仓库中安装 `.vsix` 文件。

扩展会自动管理 Forge LSP 服务器的生命周期。

## Neovim

使用 `nvim-lspconfig` 将 Forge 添加到你的 LSP 配置中：

```lua
local lspconfig = require('lspconfig')

lspconfig.forge.setup({
  cmd = { "forge-lsp" },
  filetypes = { "cs", "fsharp" },
  root_dir = lspconfig.util.root_pattern("*.sln", "*.csproj", "*.fsproj"),
})
```

## Helix

添加到你的 `languages.toml`：

```toml
[[language]]
name = "c-sharp"
language-servers = ["forge-lsp"]

[language-server.forge-lsp]
command = "forge-lsp"
```

## Emacs（lsp-mode）

```elisp
(lsp-register-client
  (make-lsp-client
    :new-connection (lsp-stdio-connection '("forge-lsp"))
    :major-modes '(csharp-mode fsharp-mode)
    :server-id 'forge-lsp))
```

## Zed

仓库中包含 Zed 集成，但当前主要可用和测试界面仍是 VS Code。
