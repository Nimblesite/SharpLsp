---
layout: layouts/blog.njk
title: "Blazor and Razor in VS Code: C# Tooling for .razor Files"
description: "SharpLsp now edits Blazor components, Razor Pages and MVC views in VS Code: C# hover, completion, diagnostics, go to definition and rename in .razor and .cshtml files."
date: 2026-10-20
author: SharpLsp Team
image: /assets/images/blog/blazor-razor-vs-code.png
imageAlt: "A polished metal @ sculpture glowing with amber fire above layered glass, edged in cyan light"
tags:
  - posts
  - blazor
  - razor
  - csharp
  - dotnet-lsp
category: announcement
excerpt: "Blazor components, Razor Pages and MVC views now get the same Roslyn engine as your C# files: hover, completion, diagnostics, go to definition, references and rename, inside the markup."
---

SharpLsp now understands Razor. Blazor components (`.razor` files), and Razor Pages and MVC views (`.cshtml` files), get the same Roslyn engine as the rest of your C#. You get hover, completion, diagnostics, go to definition, references and rename, inside the markup. It ships in SharpLsp 0.30.

Here it is on a small Blazor Web App:

{% video "blazor" %}

## What is Blazor? Blazor vs Razor in one minute

The two names describe different layers, which is why they are easy to mix up.

- **Razor** is the syntax. It mixes HTML with C#: an `@` expression, an `@if` or `@foreach` block, a `@code` block. Microsoft's [Razor syntax reference](https://learn.microsoft.com/en-us/aspnet/core/mvc/views/razor?view=aspnetcore-10.0) covers all of it.
- **ASP.NET Core Razor Pages and MVC views** are `.cshtml` files that the server renders for each request. Read [Razor Pages in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/razor-pages/?view=aspnetcore-10.0) and [Views in ASP.NET Core MVC](https://learn.microsoft.com/en-us/aspnet/core/mvc/views/overview?view=aspnetcore-10.0).
- **Blazor** is the component framework. A [Razor component](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/?view=aspnetcore-10.0) is a `.razor` file. A Blazor Web App, the `dotnet new blazor` template since .NET 8, runs components on the server or in the browser on WebAssembly. Each component picks its [render mode](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-10.0): static server rendering, `InteractiveServer`, `InteractiveWebAssembly` or `InteractiveAuto`.

Under all three sits one Razor compiler, which turns every Razor file into C#. That is why one implementation in SharpLsp serves Blazor Server, Blazor WebAssembly, Razor Pages and MVC alike.

## What you get in a .razor file

Everything below is shown on the `Basket.razor` page of the demo in the video, and each item is covered by an automated test.

- **Hover.** Hover `@Total()` and Roslyn shows the signature of `Basket.Total()` with its XML summary. Hover `@Body` in a layout and you see the `LayoutComponentBase.Body` property it renders.
- **Completion.** Roslyn's member completion inside `@` expressions and `@code` blocks. Every edit lands in the `.razor` file, and a `using` that completion adds becomes an `@using` line.
- **Diagnostics.** A C# mistake is reported on the Razor line that caused it, with its compiler code, in the editor and in the Problems panel. The solution-wide scan includes Razor files.
- **Go to definition.** F12 on `Add` in `@onclick="() => Add(product)"` jumps into the `@code` block. F12 on `Catalog.Products` opens `Catalog.cs`. From C#, F12 on `App` in `app.MapRazorComponents<App>()` opens `App.razor`, not a generated class.
- **References and highlights.** Every use in your Razor files, with the compiler's generated scaffolding left out.
- **Rename.** Rename a `@code` field, and every use in the markup follows.
- **Structure.** Multi-line elements and `@code` blocks fold, the outline lists directives and elements, and renaming a start tag renames its end tag.
- **Signature help** inside calls, and **semantic highlighting** for the C# in the file.

The markup around the C# is still HTML. In VS Code, SharpLsp forwards element and attribute completion and HTML hovers to VS Code's own HTML language service. It sends an HTML view of the file in which every C# fragment is blanked, so the HTML service never mistakes C# for markup.

## How it works: the Razor compiler is the source of truth

The tempting way to build Razor tooling is to write a Razor parser. SharpLsp doesn't. Razor's semantics belong to the Razor compiler, and any second parser would drift from it with every release.

Since .NET 6, [the Razor compiler has been a C# source generator](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-6.0?view=aspnetcore-10.0#razor-compiler-updated-to-use-source-generators). It ships in the .NET SDK, and the C# sidecar's design-time build runs it exactly as `dotnet build` does. The generator turns each Razor file into a C# class. Every C# fragment is copied into that class verbatim, inside an [enhanced `#line` directive](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-10.0/enhanced-line-directives.md) that points back at the Razor text.

SharpLsp builds a two-way map from those directives:

1. A request at a Razor position maps to the same character in the generated C#.
2. Roslyn answers there, exactly as it would for a `.cs` file.
3. Every location in the answer maps back to the Razor file.

The map never trusts a directive blindly. Roslyn reports each mapped span's end one character past the fragment, so SharpLsp measures every fragment by comparing the Razor text with the generated text, character by character. A position in code the generator wrote by itself, such as the `__builder` calls that render the markup, has no Razor text and never reaches you.

Because the generator is the compiler's, the C# inside every construct it maps gets the same treatment. That includes `@bind` values, event handlers, generic components and `@code` blocks. The markup side, which drives folding, the outline, linked editing and the HTML view, comes from the compiler's public [intermediate representation](https://github.com/dotnet/razor), not from a reimplementation.

## Found while building it

Running the real host over a fresh `dotnet new blazor` app found one false report: every `@using` in `_Imports.razor` was faded as unnecessary. Roslyn only sees each file's own generated C#, so it can't see that an import file's usings serve the components beside and below it. A component's own usings had the same problem when only its markup needed them. Razor files no longer report unnecessary usings, and C# files, code-behind included, still do.

The second finding is about SDK versions. The Razor generator comes from the SDK that builds your project, which is the newest one installed unless a `global.json` pins another. SDK 10.0.401's generator needs a newer Roslyn than the one SharpLsp bundles, so at first its Razor files got no C# features ([issue #399](https://github.com/Nimblesite/SharpLsp/issues/399)). SharpLsp now loads the Razor compiler it bundles in that generator's place, and logs a warning that names both Roslyn versions, so a newer SDK works without a pin. The [Blazor and Razor docs](/docs/blazor/) have the details.

## Blazor on .NET 10: Server, WebAssembly and Razor class libraries

SharpLsp reads the projects your solution already has. They all load the same way, through `Microsoft.NET.Sdk.Web`, `Microsoft.NET.Sdk.BlazorWebAssembly` or `Microsoft.NET.Sdk.Razor`:

- a Blazor Web App, with Blazor Server or Blazor WebAssembly interactivity;
- a standalone Blazor WebAssembly app;
- a Razor Pages or MVC app;
- a [Razor class library](https://learn.microsoft.com/en-us/aspnet/core/razor-pages/ui-class?view=aspnetcore-10.0) of shared components.

ASP.NET Core 10 on the [.NET 10](https://devblogs.microsoft.com/dotnet/announcing-dotnet-10/) SDK is verified, including a fresh `dotnet new blazor` app. Projects on net8.0 and net9.0 compile Razor through the same source generator, so they should work, but we haven't verified them yet. Projects older than .NET 6 compile Razor without a source generator and aren't supported, and neither are .NET Framework's MVC 5 and Web Forms.

## What's next

This release covers the C# in Razor files. The markup itself is next, tracked in [issue #397](https://github.com/Nimblesite/SharpLsp/issues/397):

- hover, definition, completion and references on component tags, component parameters, `@bind-Value` and directive attributes such as `@onclick`;
- the compiler's own `RZ` diagnostics, such as an unknown component;
- tag helpers in Razor Pages and MVC views, such as `asp-for`;
- F# libraries behind a Blazor front end: hover, completion and definition on F# types from Razor, and F# renames that reach Razor usages;
- formatting, code actions such as extracting a component, and Hot Reload.

## Try it

1. Install SharpLsp from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp), or from [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) in Cursor, Windsurf and VSCodium. Razor support needs version 0.30 or later.
2. Create a Blazor Web App with `dotnet new blazor -o BlazorDemo`, and open the folder.
3. Open `Components/Pages/Counter.razor` and hover `currentCount`.

The [Blazor and Razor docs](/docs/blazor/) list every feature, the supported projects and what is not supported yet.

## Further reading

- [ASP.NET Core Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/?view=aspnetcore-10.0) and [Blazor hosting models](https://learn.microsoft.com/en-us/aspnet/core/blazor/hosting-models?view=aspnetcore-10.0)
- [Blazor project structure](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0) and [Blazor render modes](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-10.0)
- [Blazor data binding](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/data-binding?view=aspnetcore-10.0) and [event handling](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/event-handling?view=aspnetcore-10.0)
- [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0)
- [Tag Helpers in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/mvc/views/tag-helpers/intro?view=aspnetcore-10.0)
- [The dotnet/razor repository](https://github.com/dotnet/razor) and [the dotnet/aspnetcore repository](https://github.com/dotnet/aspnetcore)
- [Embedded Programming Languages](https://code.visualstudio.com/api/language-extensions/embedded-languages), the VS Code guide to request forwarding
