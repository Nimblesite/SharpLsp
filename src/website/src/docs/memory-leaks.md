---
layout: layouts/docs.njk
title: Fix a Memory Leak in C# and .NET
description: "How to find and fix a memory leak in C# and .NET: what a memory leak is, memory leak detection with a free .NET memory profiler in VS Code, and fixes for static caches, event handlers, Dispose and dependency injection lifetimes."
eleventyExcludeFromCollections: true
---

# Fix a Memory Leak in C# and .NET

This guide shows how to find and fix a memory leak in a C# or F# app with the SharpLsp memory profiler in VS Code. You track the process, read the leak suspects, find the reference that keeps the objects alive, fix it, and check the fix. It works on any running .NET 8 or later process, with no restart, no memory dump and no license.

{% video "profiler-fix-memory-leak" %}

## What is a memory leak in .NET?

.NET has garbage collection: the runtime frees every object that nothing references any more. So a .NET memory leak is not memory you forgot to free. It is an object that something still holds, so the garbage collector can never free it. Under steady load the process's memory climbs and never comes back down, until the app slows to a crawl or runs out of memory.

The walkthrough uses SharpLsp's Storefront demo app. Its `SessionCache` keeps every order in a static `Dictionary` and never removes one:

```csharp
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order) => Sessions[order.Id] = new CustomerSession(order);
}
```

## Before you start

- Install SharpLsp and open the folder that holds your project.
- Run the app on a .NET 8 or later runtime. A process started with `DOTNET_EnableDiagnostics=0` can't be attached.
- Put the app under steady load: repeat the request, page or job you suspect. A leak only shows while the leaking code runs.

## 1. Confirm the memory keeps climbing

Open the SharpLsp view and find your app under **Processes**. Each row shows the process's live CPU and memory. Watch the memory for a minute under steady load. Memory that rises and falls is garbage collection at work. Memory that only rises is a leak candidate.

## 2. Track memory

Hover the row and click **Track Memory**, or run **SharpLsp: Start Memory Tracking**. The **SharpLsp Memory Dashboard** opens beside your code. It shows current and peak memory, the live object count and a heap timeline.

Turn on timed heap snapshots so the dashboard does the memory leak detection for you:

```json
{
  "sharplsp.profiler.autoSnapshot": true,
  "sharplsp.profiler.autoSnapshotInterval": 10
}
```

You can also take snapshots yourself with **SharpLsp: Take Memory Snapshot** and compare them with **SharpLsp: Compare Memory Snapshots**. Run **SharpLsp: Force Garbage Collection** before a snapshot to rule out garbage that simply hasn't been collected yet.

## 3. Read the leak suspects

Each snapshot is compared with the one before it. A type whose memory grows becomes a leak suspect, and its confidence rises with every consecutive growth:

| Evidence | Confidence |
|---|---|
| One growth | Low |
| Two growths in a row, or one growth over 10 MiB | Medium |
| Three growths in a row | High |

A snapshot where the type doesn't grow resets its streak, so normal churn rarely reaches High. Each suspect shows its growth in bytes and objects. Click a suspect to open its allocation site. In the editor, the leaking type's declaration gets a purple heat bar and a leak marker. When the first suspect reaches High, SharpLsp offers **Show Reference Graph** in a notification.

## 4. Find what keeps it alive

Run **SharpLsp: Show Reference Graph** and pick the suspect's type. The list offers the types the runtime reported in the latest snapshot. Choose **Other type…** to enter a name exactly as the runtime spells it, such as `Storefront.CustomerSession`.

The retention graph draws the objects that hold the type and the roots that keep them alive. Read it from the root down, then find the field in your code that holds the root. In Storefront, every `CustomerSession` hangs off the entry array of one `Dictionary<int, CustomerSession>`, and the only field of that type is the static `SessionCache.Sessions`.

Heap growth is a signal, not proof. Confirm a suspect with its retention path and with what the code is meant to do: a cache that is supposed to hold everything is not a leak.

## 5. Fix the memory leak

The retention path names the reference to cut. These are the common causes of a C# memory leak:

| The path ends at | Fix |
|---|---|
| A static collection or cache | Bound it: evict old entries, cap the size, or use `MemoryCache` with an expiration |
| An event on a long-lived object | Unsubscribe with `-=` when the subscriber is done, for example in its `Dispose` |
| A singleton service | Check dependency injection lifetimes: a singleton that captures a scoped or transient service keeps it alive for the app's lifetime |
| A timer or a running task | Dispose the timer and cancel the task when its owner goes away |
| A lambda stored on a long-lived object | The closure captured the object: capture less, or remove the delegate when you are done |

Storefront's fix keeps a window of the last 1,000 orders and evicts the rest:

```csharp
public static void Remember(Order order)
{
    Sessions[order.Id] = new CustomerSession(order);
    Sessions.Remove(order.Id - 1_000);
}
```

The same leak in F# is a module-level `Dictionary`, and the fix is the same:

```fsharp
let private sessions = Dictionary<int, CustomerSession>()

let remember (order: Order) =
    sessions[order.Id] <- CustomerSession order
    sessions.Remove(order.Id - 1_000) |> ignore
```

## 6. Check the fix

Rebuild, run the app under the same load and track memory again. The heap timeline should level off once the cache fills, and no suspect should climb to High. If one still does, show its reference graph again: a second root is holding it.

## Questions

### Does Dispose fix a memory leak?

Only when the leak is the thing `Dispose` releases. `Dispose` and the `using` statement release unmanaged resources, such as handles, sockets and native memory, at a known time. They don't make an object collectable while something still references it. A disposed object held by a static list is still a leak. `Dispose` helps when it is where you unsubscribe events or stop timers.

### Do I need a heap dump or a memory dump?

No. `dotnet-dump` and `dotnet-gcdump` write a file you then open in another tool, such as Visual Studio or PerfView. SharpLsp reads heap snapshots from the running process through the runtime's diagnostics channel, so the memory profiler works in the editor on Windows, macOS and Linux. Use a dump when you need to keep the evidence, or when the process runs on a machine you can't attach to.

### Is this the Visual Studio memory profiler?

No. It is SharpLsp's own memory profiler, open source and MIT-licensed. It covers the same loop, snapshots, comparison and retention paths, inside VS Code, Cursor, Windsurf and VSCodium.

## Related

- [Profiler](/docs/profiler/): every profiler command and setting
- [Configuration](/docs/configuration/): the `[profiler]` table in `sharplsp.toml`
- [How to Fix a Memory Leak in C# and .NET, Step by Step](/blog/how-to-fix-a-memory-leak-in-csharp-dotnet/): one leak, from first suspicion to a measured fix
