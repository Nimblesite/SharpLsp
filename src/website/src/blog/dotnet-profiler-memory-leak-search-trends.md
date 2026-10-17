---
layout: layouts/blog.njk
title: "What .NET Developers Search for When an App Is Slow or Leaking Memory"
description: "Five years of Google Trends data on .NET profiling, CPU, memory and memory leak detection: what developers type when an app is slow, which tools they name, and how SharpLsp's profiler answers each search in VS Code."
date: 2026-10-17
author: SharpLsp Team
image: /assets/images/blog/dotnet-profiler-memory-leak-search-trends.png
imageAlt: Google Trends bars showing high cpu usage searched fifteen times more than cpu profiler, beside a SharpLsp heat map on C# code in VS Code
tags:
  - posts
  - profiling
  - memory-leaks
  - csharp
  - fsharp
category: profiling
excerpt: "People search “high cpu usage” fifteen times more than “cpu profiler”, and “c# dispose” seven times more than “c# memory leak”. We read five years of Google Trends on .NET profiling and memory leaks, then checked where SharpLsp answers each search."
---

We read five years of Google Trends data on .NET profiling, CPU, memory and memory leak detection. We wanted to know what developers type when an app is slow or its memory keeps climbing, and which tools they name. The short version: **people search for the symptom, not the tool**, and more of them now search from VS Code.

This post walks through what the data says and how the SharpLsp profiler answers each search. Here is the profiler in one minute:

{% video "profiler-film" %}

## How we measured

We used Google Trends: worldwide web search, weekly, from October 2021 to October 2026. We compared terms five at a time and read each term's top and rising related queries.

Trends values are relative. 100 is the busiest week of the busiest term *in that comparison*, so a number only means something next to the others in its own table. Yearly figures average the weekly values. 2021 covers its last eleven weeks, and 2026 runs to mid-October. Terms below Google's volume floor show as 0.

Many terms rose in 2026. Others in the same comparisons, such as "visual studio profiler" and "high cpu usage", stayed flat or fell, so the rises are not a uniform shift in Google's data.

## 1. People search the symptom, not the tool

| Search term | 5-year average |
|---|---:|
| high cpu usage | 53.2 |
| performance profiler | 6.0 |
| flame graph | 5.5 |
| cpu profiler | 3.5 |
| cpu profiling | 2.5 |

"high cpu usage" is searched fifteen times more than "cpu profiler". Most of those searchers are Windows users and gamers: the top related queries are about Windows 11, Chrome and antimalware. Developers start in the same place, though. Something is slow, and they don't yet know what.

Memory works the same way. In a separate comparison, "memory leak" averaged 21.0 and "memory profiling" 1.4, again fifteen to one. The biggest intent is the fix: "fix memory leak" rose from 10.2 in 2024 to 24.2 in 2026, and "how to fix memory leak" more than tripled. Minecraft players drive much of that, but "how to fix a memory leak" sits right behind the mod names.

So the SharpLsp profiler starts at the symptom. The **Processes** view lists every .NET process on the machine with its live CPU and memory, so the one burning a core or growing without bound is visible before you profile anything. Hover its row and click **Profile CPU**. This recording is unedited and in real time:

{% video "profiler-cpu-recording" %}

The hot lines light up in your code with their share of the samples. You see the line, not just the method.

## 2. .NET profiling searches are growing

| Year | .net profiler | java profiler | python profiler | go pprof |
|---|---:|---:|---:|---:|
| 2022 | 7.7 | 32.0 | 42.8 | 15.8 |
| 2023 | 6.6 | 30.3 | 44.7 | 17.4 |
| 2024 | 4.9 | 31.1 | 44.8 | 21.8 |
| 2025 | 8.9 | 26.4 | 42.9 | 20.7 |
| 2026 | 11.8 | 27.6 | 57.6 | 33.2 |

".net profiler" is the smallest of the four, but it is up by half since 2022 while Java profiler searches fell. ".net performance" and "c# performance" both roughly doubled from 2025 to 2026, from 15.6 to 29.6 and from 15.3 to 28.7. Their rising related queries name releases: ".net 10", "performance improvements in .net 8", ".net aspire". The runtime gets faster every year. Then developers want to find the slow parts of their own code.

The other ecosystems show what kind of profiler people want now. Python's breakout profiler searches are memray, Scalene and py-spy (+800%). Java's is async-profiler (+2,000%). All of them are low-overhead sampling profilers that attach to a running process and draw flame graphs. "flame graph" itself rose from 5.6 in 2025 to 13.9 in 2026, and "cpu profiler" from 2.5 to 11.2.

That is the shape of the SharpLsp profiler. It samples at 100 Hz through the runtime's own diagnostics channel, attaches to a process that is already running, and needs no restart or rebuild. The results panel opens a flame graph you can zoom into:

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-flamegraph-zoom.webp" alt="Flame graph zoomed into ParseCatalog, showing the System.Text.Json deserialization stack" width="2400" height="345">
  <figcaption>Zoomed into <code>ParseCatalog</code>: the System.Text.Json deserializer is the cost.</figcaption>
</figure>

## 3. Memory comes first

When people search ".net profiler", the related queries lead with memory:

| Related query | Relative interest |
|---|---:|
| memory profiler | 100 |
| .net memory profiler | 99 |
| visual studio profiler | 63 |
| .net performance profiler | 60 |
| c# profiler | 44 |

In the memory comparison, "memory profiler" rose from 32.8 in 2025 to 47.7 in 2026, and "memory leak detection" nearly tripled, from 9.8 to 27.3.

## 4. C# developers search the mechanism

| Search term | 5-year average |
|---|---:|
| c# performance | 14.7 |
| .net performance | 10.6 |
| c# dispose | 5.9 |
| c# garbage collection | 1.7 |
| c# memory leak | 0.8 |

"c# dispose" is searched seven times more than "c# memory leak". The leak's own related queries are "visual studio memory leak", "c# dispose" and "what is memory leak" (+170%). Around `Dispose`, the rising queries are "c# using statement" (+120%) and "dependency injection c#" (+90%). Around garbage collection, they are ".net core" (+190%) and interview questions.

That matches how managed leaks really happen. The garbage collector frees anything nothing references, so a .NET leak is an object something still holds: a static cache that never evicts, an event handler that is never removed, or a singleton that captured a scoped service. `Dispose` releases unmanaged resources, but it does not make a referenced object collectable. To find a leak, you watch what grows and ask what keeps it alive.

That is what **Track Memory** does. The memory dashboard opens beside your code and snapshots the heap as the app runs. It ranks leak suspects by how consistently they grow, and it flags the leaking type's declaration in the editor. Sped up three times:

{% video "profiler-memory-timelapse" %}

<figure class="article-figure">
  <img src="/assets/screenshots/profiler/profiler-leaks.webp" alt="Suspected leaks ranked HIGH with growth in megabytes and object counts, and an inline HIGH leak marker on the CustomerSession declaration in SessionCache.cs" width="2400" height="1500">
  <figcaption>Leak suspects. The static <code>Dictionary</code> that never evicts shows up as consistent growth in byte arrays, strings and the sessions that hold them.</figcaption>
</figure>

**Show Reference Graph** then draws what keeps the suspect alive, back to its root. Because "fix memory leak" is the search people make most, we wrote it up twice: the [Fix a Memory Leak](/docs/memory-leaks/) guide covers the loop step by step, and [How to Fix a Memory Leak in C# and .NET](/blog/how-to-fix-a-memory-leak-in-csharp-dotnet/) follows one real leak from first suspicion to a verified fix.

## 5. The tools people name belong to an IDE

The biggest profiler term is "visual studio profiler". It averaged 15.2 and stayed flat for five years. ".net memory profiler" leads to "visual studio memory profiler", and "visual studio performance profiler" is rising (+250%).

JetBrains' related searches are about Rider: "rider" is the top rising query for both dotTrace (+140%) and dotMemory (+130%). dotTrace interest peaked in 2023 at 14.6 and fell to 5.6 in 2026, the year PerfView passed it. Two of dotMemory's breakout related searches are for an activation code and a modded build. People want the tool more than the license.

Meanwhile, the editor moved:

| Year | c# dev kit | visual studio profiler | vs code profiler |
|---|---:|---:|---:|
| 2023 | 12.2 | 14.9 | 0 |
| 2024 | 18.1 | 13.5 | 0.2 |
| 2025 | 24.9 | 14.7 | 2.4 |
| 2026 | 48.8 | 15.0 | 6.5 |

C# Dev Kit searches quadrupled after its 2023 launch and now run at three times "visual studio profiler". "visual studio code" is a top related query for "visual studio profiler", and still rising (+40%). Developers want the Visual Studio profiler where they now write code.

The SharpLsp profiler runs in VS Code, Cursor, Windsurf and VSCodium. It is MIT-licensed and needs no account. It covers C# and F# alike, because the engine attaches to the .NET runtime, not to a language.

## 6. The command-line tools are surging

| Year | dotnet-trace | dotnet-counters | dotnet-dump | dotnet-gcdump | perfview |
|---|---:|---:|---:|---:|---:|
| 2024 | 0.8 | 0 | 0.6 | 0 | 10.5 |
| 2025 | 4.8 | 3.6 | 2.3 | 0 | 33.9 |
| 2026 | 12.2 | 14.8 | 1.1 | 0 | 42.2 |

The .NET diagnostics tools went from almost nothing to real interest in two years. In another comparison, "dotnet monitor" rose from 2.5 in 2024 to 34.4 in 2026. BenchmarkDotNet, the biggest .NET performance term we measured, doubled in 2026, from 23.0 to 47.1.

These tools are excellent, and SharpLsp's engine reads the same EventPipe channel as `dotnet-trace`. The difference is where the answer lands. A `.nettrace` or `.gcdump` file still has to be opened in PerfView, Visual Studio or speedscope, and what you read there is a stack, not your line of code. SharpLsp puts the answer on the line in the editor. Every CPU session still writes a speedscope JSON, a `.cpuprofile` and the flame graph SVG, so you can share the result or keep it.

## What people search for, and where SharpLsp answers

| They search | SharpLsp answers with |
|---|---|
| high cpu usage | The live CPU column in **Processes**, then **Profile CPU** on that row |
| fix memory leak | **Track Memory**, ranked leak suspects, then **Show Reference Graph** |
| .net memory profiler | The memory dashboard: heap timeline, top allocation sites and leak suspects |
| c# dispose, dependency injection | The retention path, which shows what still holds the object |
| flame graph | The results panel's zoomable flame graph, with an SVG export |
| visual studio profiler, in VS Code | All of the above, in VS Code and its forks, MIT-licensed |
| dotnet-trace, perfview | The same runtime channel, with the answer on your line |

## Try it

Install SharpLsp from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp), or from [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) in Cursor, Windsurf and VSCodium. Open the SharpLsp view and find your app under **Processes**. The engine needs a .NET 8 or later runtime. The [profiler docs](/docs/profiler/) cover every command and setting.
