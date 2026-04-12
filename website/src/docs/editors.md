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

[[language]]
name = "fsharp"
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

Forge ships a Zed extension that attaches `forge-lsp` over stdio for `.cs`, `.csx`, `.fs`, `.fsx`, and `.fsi` files. Zed compiles extensions from source at install time, so the repo's `make package-zed` target stages a self-contained source tree.

```sh
rustup target add wasm32-wasip1   # one-off
make package-zed                  # stages target/zed-extension/
```

Then in Zed: command palette → `zed: install dev extension` → pick `target/zed-extension/`. Hover, completions, go-to-definition, and diagnostics all work. The `/forge-tree <Solution.sln>` slash command renders the solution tree in the assistant panel.
