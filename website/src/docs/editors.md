---
layout: layouts/docs.njk
title: Editor Setup
eleventyNavigation:
  key: Editor Setup
  order: 3
---

# Editor Setup

Forge works with any editor that supports the Language Server Protocol. Below are setup instructions for popular editors.

## VS Code

Install the Forge extension from the marketplace or from the `.vsix` file in the repository.

The extension automatically manages the Forge LSP server lifecycle.

## Neovim

Add Forge to your LSP configuration using `nvim-lspconfig`:

```lua
local lspconfig = require('lspconfig')

lspconfig.forge.setup({
  cmd = { "forge-lsp" },
  filetypes = { "cs", "fsharp" },
  root_dir = lspconfig.util.root_pattern("*.sln", "*.csproj", "*.fsproj"),
})
```

## Helix

Add to your `languages.toml`:

```toml
[[language]]
name = "c-sharp"
language-servers = ["forge-lsp"]

[language-server.forge-lsp]
command = "forge-lsp"
```

## Emacs (lsp-mode)

```elisp
(lsp-register-client
  (make-lsp-client
    :new-connection (lsp-stdio-connection '("forge-lsp"))
    :major-modes '(csharp-mode fsharp-mode)
    :server-id 'forge-lsp))
```

## Zed

Forge support for Zed is planned. Check the repository for the latest status.
