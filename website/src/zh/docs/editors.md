---
layout: layouts/docs.njk
title: 编辑器配置
lang: zh
eleventyNavigation:
  key: 编辑器配置（中文）
  order: 3
---

# 编辑器配置

Forge 适用于任何支持语言服务器协议的编辑器。以下是主流编辑器的配置说明。

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

Forge 对 Zed 的支持正在规划中。请查看仓库以获取最新状态。
