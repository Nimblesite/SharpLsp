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

Build and install the Forge extension from the repository:

```sh
make build-vsix
code --install-extension forge.vsix
```

The extension manages the Forge LSP server lifecycle and provides the Solution Explorer, profiler, NuGet browser, test lens, and editor status integration.

## Zed

Forge ships a Zed extension that attaches `forge-lsp` over stdio for `.cs`, `.csx`, `.fs`, `.fsx`, and `.fsi` files. Zed compiles extensions from source at install time, so the repo's `make package-zed` target stages a self-contained source tree.

```sh
rustup target add wasm32-wasip1
make package-zed
```

Then in Zed: command palette -> `zed: install dev extension` -> pick `target/zed-extension/`. Hover, completions, go-to-definition, and diagnostics all work through the language server. The `/forge-tree <Solution.sln|Solution.slnx>` slash command renders the solution tree in the assistant panel.

## JetBrains Rider

Build the plugin package:

```sh
make package-rider
```

Then in Rider: **Settings -> Plugins -> Install Plugin from Disk** and pick `forge-rider.zip`. Restart Rider. The plugin attaches `forge-lsp` over LSP for C# and F# files and adds a **Forge Solution** tool window backed by the same custom LSP requests as VS Code.

## Neovim

Register Forge as a custom LSP server using `nvim-lspconfig`:

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.forge_lsp then
  configs.forge_lsp = {
    default_config = {
      cmd = { "forge-lsp" },
      filetypes = { "cs", "fsharp" },
      root_dir = lspconfig.util.root_pattern("*.sln", "*.slnx", "*.csproj", "*.fsproj"),
    },
  }
end

lspconfig.forge_lsp.setup({})
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

## Emacs

### lsp-mode

```elisp
(lsp-register-client
  (make-lsp-client
    :new-connection (lsp-stdio-connection '("forge-lsp"))
    :major-modes '(csharp-mode fsharp-mode)
    :server-id 'forge-lsp))
```

### eglot

```elisp
(add-to-list 'eglot-server-programs
             '((csharp-mode fsharp-mode) . ("forge-lsp")))
```

## Sublime Text

Install the [LSP](https://packagecontrol.io/packages/LSP) package, then add a custom client in **Settings > Package Settings > LSP > Settings**:

```json
{
  "clients": {
    "forge-lsp": {
      "enabled": true,
      "command": ["forge-lsp"],
      "selector": "source.cs | source.fsharp"
    }
  }
}
```
