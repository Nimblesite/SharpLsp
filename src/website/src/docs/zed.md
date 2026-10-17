---
layout: layouts/docs.njk
title: SharpLsp in Zed
description: "Install and use SharpLsp in the Zed editor for C# and F#: the dev extension, choosing SharpLsp over OmniSharp, Roslyn, csharp-ls and fsautocomplete, where the server comes from, settings, logs and troubleshooting."
eleventyExcludeFromCollections: true
---

# SharpLsp in Zed

SharpLsp runs in [Zed](https://zed.dev) as the language server for C# and F#. Zed's own C# and F# extensions supply the languages and syntax highlighting. SharpLsp attaches to those languages and supplies the code intelligence.

SharpLsp will ship as a `sharplsp` server option inside Zed's [C#](https://github.com/zed-extensions/csharp) and [F#](https://github.com/nathanjcollins/zed-fsharp) extensions. Until then, install it from this repository as a Zed dev extension. The server id and every setting on this page stay the same when that option ships.

## Requirements

- [Zed](https://zed.dev/download).
- The [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0). The C# and F# sidecars need the SDK, not only the runtime. Unlike the VS Code extension, the Zed extension doesn't install it for you.
- Rust, [installed with rustup](https://www.rust-lang.org/tools/install). Zed compiles dev extensions to WebAssembly and fetches the target it needs through rustup. With Rust from Homebrew or a Linux package, you have to add that target yourself.
- macOS on Apple silicon, Linux (x64 or arm64), or Windows (x64 or arm64). There is no server download for Intel Macs. See [Where the server comes from](#where-the-server-comes-from).

## Install

1. **Install the C# and F# extensions.** Open the Extensions page (<kbd>Cmd+Shift+X</kbd> on macOS, <kbd>Ctrl+Shift+X</kbd> on Linux and Windows) and install **C#** and **F#**. They define the `CSharp` and `FSharp` languages that SharpLsp attaches to. Without them, SharpLsp never starts.
2. **Clone SharpLsp.**

   ```sh
   git clone https://github.com/Nimblesite/SharpLsp.git
   ```

3. **Install the dev extension.** On the Extensions page, click **Install Dev Extension**, or run `zed: install dev extension` from the command palette. Select the `src/editors/zed` folder inside the clone. Zed compiles the extension and lists it as **SharpLsp**.
4. **Make SharpLsp the C# and F# server.** Add the `languages` block from [Choose SharpLsp](#choose-sharplsp) to your Zed settings.
5. **Open your code.** Open a folder that contains a `.sln`, `.slnx`, `.csproj` or `.fsproj`. If Zed asks whether to trust it, trust it: Zed starts no language servers in restricted mode. Then open a `.cs` or `.fs` file.

The first time, Zed shows SharpLsp checking for the server and downloading it beside the language server's name. After that, the server starts straight away.

## Choose SharpLsp

The C# extension also registers OmniSharp, Roslyn and csharp-ls, and the F# extension registers fsautocomplete. Unless you turn them off, they run beside SharpLsp and you get duplicate completions and diagnostics. Run `zed: open settings file` and add:

```json
{
  "languages": {
    "CSharp": {
      "language_servers": ["sharplsp", "!omnisharp", "!roslyn", "!csharp-ls", "..."]
    },
    "FSharp": {
      "language_servers": ["sharplsp", "!fsautocomplete", "..."]
    }
  }
}
```

A `!` turns a server off, and `"..."` keeps any other server registered for the language. To choose SharpLsp for one repository only, put the same block in that repository's `.zed/settings.json` (`zed: open project settings`).

## Where the Server Comes From

The extension never bundles the server. When Zed starts SharpLsp, the extension uses the first of these it finds:

1. the `lsp.sharplsp.binary.path` setting;
2. `sharplsp` on your `PATH`, for example from `brew install nimblesite/tap/sharplsp` on macOS and Linux or `scoop install nimblesite/sharplsp` on Windows;
3. the latest stable [SharpLsp release](https://github.com/Nimblesite/SharpLsp/releases) for your platform, downloaded from GitHub into the extension's own folder.

The download includes the server and both sidecars. On each new Zed session, the extension checks for a newer release, downloads it if there is one, and removes older downloads. When GitHub can't be reached, the newest earlier download starts instead. The extension can download only from the SharpLsp repository's releases.

Intel Macs have no release archive. On one, Zed reports that SharpLsp publishes no server for macOS x86-64. Build the server from source (see [Contributing](/docs/contributing/)) and set `lsp.sharplsp.binary.path` to it.

## Settings

Every SharpLsp setting in Zed lives under `lsp.sharplsp`:

```json
{
  "lsp": {
    "sharplsp": {
      "binary": {
        "path": "/opt/homebrew/bin/sharplsp",
        "arguments": [],
        "env": { "DOTNET_ROOT": "/usr/local/share/dotnet", "RUST_LOG": "debug" }
      },
      "settings": {
        "csharp": { "solution_path": "src/Storefront.slnx" },
        "analyzers": { "dead_code": true }
      }
    }
  }
}
```

| Setting | Purpose |
|---|---|
| `binary.path` | The server to start, instead of `PATH` or the download |
| `binary.arguments` | Extra arguments for whichever server starts |
| `binary.env` | Environment variables for the server. Each one overrides the same variable from your shell. `RUST_LOG` sets the log level, and is `info` unless you set it |
| `settings` | Server settings, in the [`sharplsp.toml` schema](/docs/configuration/) written as JSON |

`settings` sits above your personal `config.toml` and the workspace's `sharplsp.toml`, so a value set here wins. Server and sidecar settings take effect when the server restarts. Run `editor: restart language server` to apply them.

## What Works in Zed

Zed shows everything SharpLsp provides through the Language Server Protocol, for C# and F# alike:

- [completions](/docs/completions/) and [hover](/docs/hover/);
- [go to definition](/docs/go-to-definition/), find references and rename;
- [diagnostics](/docs/diagnostics/), including SharpLsp's analyzers;
- [code actions and refactorings](/docs/refactoring/);
- formatting, semantic highlighting and document symbols.

The rest of SharpLsp's tooling is VS Code interface that Zed's extension API can't host: the Solution Explorer, the NuGet browser, the Test Explorer, the [profiler](/docs/profiler/) and debugging. Zed debugger support is planned.

## Update

The server updates itself, as described in [Where the server comes from](#where-the-server-comes-from). The dev extension doesn't. To update it, run `git pull` in your clone, then click **Rebuild** on SharpLsp's entry on the Extensions page.

## Troubleshooting

| Symptom | What to check |
|---|---|
| SharpLsp never starts | The C# and F# extensions are installed, the folder is trusted, and `sharplsp` is in the language's `language_servers` |
| The dev extension doesn't install | Rust is installed with rustup. `zed: open log` shows the build output |
| "SharpLsp publishes no server for macOS x86-64" | An Intel Mac: set `binary.path` to a server you built |
| The server starts, but nothing resolves | The .NET 10 SDK is installed: `dotnet --list-sdks` lists a 10.0 SDK. Set `DOTNET_ROOT` in `binary.env` if `dotnet` isn't on Zed's `PATH` |
| Completions or diagnostics appear twice | Another C# or F# server is still running. Turn it off with `!` in `language_servers` |

Two logs help:

- `zed: open log` shows extension errors, such as a failed download or a missing release for your platform.
- `dev: open language server logs`, or the lightning-bolt icon in the status bar, shows SharpLsp's own log and its LSP traffic. Choose **SharpLsp** in the list. Set `RUST_LOG` to `debug` in `binary.env` for more detail.
