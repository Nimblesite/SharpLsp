---
layout: layouts/docs.njk
title: NuGet Package Manager
eleventyNavigation:
  key: NuGet Package Manager
  order: 8
---

![NuGet Package Browser — browse tab](/assets/screenshots/vscode-nuget-browse.png)

*NuGet package workflows inside the alpha VS Code extension.*

# NuGet Package Manager

SharpLsp includes a built-in NuGet package browser panel for VS Code, powered by the sidecar and the official NuGet API. Install, remove, and inspect packages without leaving the extension.

## Opening the NuGet Browser

Right-click a project node in the **Solution Explorer** and select **Browse NuGet Packages**, or run the command `SharpLsp: Browse NuGet Packages` from the Command Palette.

## Browse Tab

![NuGet Package Browser — search results](/assets/screenshots/vscode-nuget-search.png)

The **Browse** tab shows popular packages by default. Type in the search box to find any package on nuget.org. Results update live as you type.

## Installed Packages

![NuGet Package Browser — installed tab](/assets/screenshots/vscode-nuget-installed.png)

The **Installed** tab lists every `<PackageReference>` in the active project. Click a package to see its details and version selector in the right-hand panel.

## Package Details

![NuGet Package details panel](/assets/screenshots/vscode-nuget-package-details.png)

Selecting a package shows its description, icon, current version, and an **Install** or **Remove** button depending on whether it is already referenced by the project.

## Reactivity

The NuGet panel is intended to react to project changes on disk. In the alpha, validate install and remove behavior against your project before relying on it for critical workflows.

## Performance Targets

| Operation | Target |
|-----------|--------|
| Package search | <500ms |
| Installed list load | <200ms |
| Install / remove | <2s |
