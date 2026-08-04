---
layout: layouts/docs.njk
title: NuGet 包管理器
lang: zh
eleventyNavigation:
  key: NuGet 包管理器（中文）
  order: 8
---

![NuGet 包浏览器 — 浏览选项卡](/assets/screenshots/vscode-nuget-browse.png)

# NuGet 包管理器

VS Code 扩展包含 NuGet 浏览器和包维护命令。Rust 宿主负责目标发现、NuGet API 查询、还原进度、未使用包分析和版本统一编排。项目文件的修改通过 .NET sidecar 的 MSBuild DOM 完成，以保留现有 XML 结构和格式。

## 打开浏览器

右键单击项目并选择 **浏览 NuGet 包**，或运行 **SharpLsp: Browse NuGet Packages**。如果工作区包含多个目标，请选择要编辑的项目或中央包文件。

浏览器支持：

- 搜索 nuget.org；
- 启用 `sharplsp.nuget.includePrerelease` 后包含预发布结果；
- 查看已安装的直接引用；
- 检查包元数据和可用版本；
- 安装、更改所选版本以及移除包。

## 项目和中央包管理

SharpLsp 会发现 `.csproj`、`.fsproj`、`Directory.Build.props` 和 `Directory.Packages.props` 目标。启用 `ManagePackageVersionsCentrally` 后，它会更新中央 `PackageVersion`，同时使项目中的 `PackageReference` 保持无版本号。

安装、更新、移除和版本统一操作可能会修改多个 MSBuild 文件。响应会报告每个被修改的文件。

## 还原和自动更新

编辑包后，宿主会在后台启动 `dotnet restore`，并向浏览器发送进度通知。解决方案资源管理器的项目依赖项存储会监视项目文件和中央包文件，因此外部编辑也能刷新包和引用节点，无需重启扩展。

## 未使用的包

在项目或解决方案上运行 **移除未使用的包**。SharpLsp 会结合直接包引用和编译器端的程序集使用情况，只建议移除它能够判定为未使用的引用。移除前，你可以查看并确认候选列表。

该分析采用保守策略：即使没有发现类型使用，只要某个包不提供编译程序集，也不会因此自动将它视为可以移除。

## 统一包版本

在解决方案上运行 **统一包版本**，查找多个项目中重复出现的包引用。命令会先执行试运行并显示建议的更改，还可以在还原受影响的项目之前，把共享的 `PackageReference` 项提升到解决方案根目录的 `Directory.Build.props`。使用中央包管理时，提升后的引用保持无版本号，因为版本仍由 `Directory.Packages.props` 提供。

## 失败行为

网络故障、无效目标、MSBuild 编辑失败和还原失败都会明确报告，不会静默改写文件。即使目标是 F# 项目，包编辑也需要 C# sidecar 基础设施，因为共享的 MSBuild DOM 编辑器目前位于其中。
