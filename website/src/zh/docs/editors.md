---
layout: layouts/docs.njk
title: 编辑器配置
lang: zh
eleventyNavigation:
  key: 编辑器配置（中文）
  order: 3
---

# 编辑器配置

![VS Code 中的 SharpLsp 编辑器支持](/assets/screenshots/vscode-editors-page.png)

SharpLsp 在 LSP 层面以编辑器无关为目标。VS Code 扩展是主要支持的界面，其他所有编辑器通过标准输入/输出连接到同一个 `sharplsp` 二进制文件。

**所有编辑器的前提条件：** 安装 [.NET 10.0 SDK](https://dotnet.microsoft.com/download) 并确保 `dotnet` 在 PATH 中。

## VS Code

从 VS Code Marketplace 安装 SharpLsp 扩展，或从源码构建：

```sh
make build-vsix
code --install-extension sharplsp.vsix
```

扩展会自动管理 `sharplsp` 服务器生命周期，提供解决方案资源管理器、性能分析器、NuGet 浏览器、测试视图和编辑器状态集成。无需额外配置。

## Zed

仓库中包含 Zed 扩展，通过 stdio 将 `sharplsp` 连接到 `.cs`、`.csx`、`.fs`、`.fsx` 和 `.fsi` 文件。这是开发者构建步骤——您需要 Rust 工具链来编译 Zed 扩展包，但**不需要**它来使用 SharpLsp 本身。

```sh
make package-zed
```

然后在 Zed 中：命令面板 → `zed: install dev extension` → 选择 `target/zed-extension/`。

> **注意：** Zed 集成处于实验阶段，VS Code 扩展是主要测试界面。

## JetBrains Rider

构建插件包：

```sh
make package-rider
```

然后在 Rider 中：**Settings → Plugins → Install Plugin from Disk**，选择 `sharplsp-rider.zip`，重启 Rider。Rider 集成处于实验阶段。

## Neovim

使用 `nvim-lspconfig` 注册 SharpLsp 为自定义 LSP 服务器：

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.sharplsp_lsp then
  configs.sharplsp_lsp = {
    default_config = {
      cmd = { "sharplsp" },
      filetypes = { "cs", "fsharp" },
      root_dir = lspconfig.util.root_pattern("*.sln", "*.slnx", "*.csproj", "*.fsproj"),
    },
  }
end

lspconfig.sharplsp_lsp.setup({})
```

## Helix

添加到您的 `languages.toml`：

```toml
[[language]]
name = "c-sharp"
language-servers = ["sharplsp"]

[[language]]
name = "fsharp"
language-servers = ["sharplsp"]

[language-server.sharplsp]
command = "sharplsp"
```

## Emacs

### lsp-mode

```elisp
(lsp-register-client
  (make-lsp-client
    :new-connection (lsp-stdio-connection '("sharplsp"))
    :major-modes '(csharp-mode fsharp-mode)
    :server-id 'sharplsp))
```

### eglot

```elisp
(add-to-list 'eglot-server-programs
             '((csharp-mode fsharp-mode) . ("sharplsp")))
```

## Sublime Text

安装 [LSP](https://packagecontrol.io/packages/LSP) 包，然后在 **Settings > Package Settings > LSP > Settings** 中添加自定义客户端：

```json
{
  "clients": {
    "sharplsp": {
      "enabled": true,
      "command": ["sharplsp"],
      "selector": "source.cs | source.fsharp"
    }
  }
}
```
