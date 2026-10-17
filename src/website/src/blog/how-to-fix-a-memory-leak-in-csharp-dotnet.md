---
layout: layouts/blog.njk
title: "How to Fix a Memory Leak in C# and .NET, Step by Step"
description: "How to find and fix a memory leak in C# and .NET, step by step in VS Code: memory leak detection with a free .NET memory profiler, the retention graph that names the cause, the fix, and the C# memory leaks behind events, Dispose, timers and dependency injection."
date: 2026-10-17
author: SharpLsp Team
image: /assets/images/blog/how-to-fix-a-memory-leak-in-csharp-dotnet.png
imageAlt: A C# memory leak traced in VS Code, from a climbing heap timeline to the static Dictionary that holds every CustomerSession
tags:
  - posts
  - profiling
  - memory-leaks
  - csharp
  - fsharp
category: profiling
excerpt: "Here is the whole fix for a C# memory leak, recorded in VS Code: spot the climb, rank the suspects, find the root, fix it and prove it."
---

Most advice on fixing a memory leak stops at "use a memory profiler". This post goes the whole way on a real C# memory leak: we find it, follow it to its root, fix it and prove the fix, all inside VS Code with the free SharpLsp memory profiler.

Here is the whole loop, recorded in VS Code. Fast-forwarded stretches are marked on screen:

{% video "profiler-fix-memory-leak" %}

## What is a memory leak in C#?

C# has garbage collection: the .NET runtime frees every object that nothing references any more. So a C# memory leak is not memory you forgot to free. It is an object that something still holds. A static list, an event or a long-lived service keeps a reference, so the garbage collector can never free it, and memory climbs for as long as the app runs.

## The leak

Our Storefront demo app checks out orders in a loop. Its `SessionCache` remembers every order "for analytics", in a static `Dictionary` that never removes anything:

```csharp
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order) => Sessions[order.Id] = new CustomerSession(order);
}
```

Each `CustomerSession` carries a 4 KB buffer. Nothing ever lets go of one.

## Step 1: Spot the climb

Open the SharpLsp view. **Processes** lists every .NET process on the machine with its live CPU and memory. Storefront's memory only goes up. Memory that rises and falls is normal garbage collection. Memory that only rises under steady load is a leak candidate.

## Step 2: Track memory

Hover the Storefront row and click **Track Memory**. The memory dashboard opens beside the code and starts taking heap snapshots, each one compared with the last. The heap timeline climbs with every snapshot.

## Step 3: Read the leak suspects

A type that grows in a snapshot becomes a suspect. Two growths in a row make it Medium, and three make it High. Within a few snapshots, `CustomerSession` and everything it holds, its byte arrays, orders and product lists, are High, with consistent growth across every snapshot. In the editor, the `CustomerSession` declaration gets a `HIGH` leak marker with its growth. Click the suspect and the editor jumps to it.

## Step 4: Find what keeps it alive

Growth tells you *what* leaks. The fix needs *why*. Run **SharpLsp: Show Reference Graph** and pick `Storefront.CustomerSession`. The retention graph draws every `CustomerSession` hanging off the entry array of one `Dictionary<int, CustomerSession>`. One field in the code has that type: the static `SessionCache.Sessions`. That is the reference to cut.

## Step 5: Fix it

The cache only needs recent orders, so keep a window of the last 1,000 and evict the rest:

```csharp
// Remembers the last 1,000 orders "for analytics", and forgets older ones.
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order)
    {
        Sessions[order.Id] = new CustomerSession(order);
        Sessions.Remove(order.Id - 1_000);
    }
}
```

In real code, `MemoryCache` with a size limit or an expiration does the same job.

## Step 6: Prove it

Rebuild, run and track memory again. In the recording, the leaking build passed 160 MB before its suspects reached High. The fixed build holds at about 8 MB, its timeline is flat, and no suspect climbs past Low. A fix you haven't measured is a guess. This one is measured.

## Four more C# memory leaks the same steps find

The steps don't change. Only the root at the end of the retention graph does.

### An event handler that is never removed

```csharp
public sealed class PriceTicker(MarketFeed feed) : IDisposable
{
    public void Start() => feed.PriceChanged += OnPriceChanged;

    public void Dispose() => feed.PriceChanged -= OnPriceChanged;

    private void OnPriceChanged(object? sender, decimal price) { }
}
```

The long-lived `MarketFeed` holds every subscriber through its event. Without the `-=`, each `PriceTicker` lives as long as the feed. The retention graph ends at the feed's event field.

### A singleton that captures a scoped service

With dependency injection, a singleton lives for the whole app. If its constructor takes a scoped service, such as a `DbContext`, that one instance is captured for the app's lifetime, along with everything it tracks. The graph ends at the singleton. Inject `IServiceScopeFactory` instead and create a scope per unit of work.

### A timer that outlives its owner

While a `System.Threading.Timer` runs, the runtime's timer queue holds its callback, and the callback holds its target. A component whose timer calls back into it is kept alive by its own timer. Dispose the timer with its owner.

### A closure in F#

```fsharp
let handlers = ResizeArray<unit -> unit>()

let watch (session: CustomerSession) =
    handlers.Add(fun () -> printfn "%d" session.SnapshotBytes)
```

The lambda captures `session`, and the module-level list keeps every lambda. The graph ends at `handlers`. Remove the delegate when you are done, or capture only the value you need.

## Does Dispose fix a memory leak?

Not on its own. `Dispose` and the `using` statement release unmanaged resources at a known time, but they don't make an object collectable while something still references it. A disposed object held by a static list is still a leak. `Dispose` fixes a leak when it is where you unsubscribe events, stop timers or clear caches, as in `PriceTicker` above.

## Try it

Install SharpLsp from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp), or from [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) in Cursor, Windsurf and VSCodium. The [Fix a Memory Leak](/docs/memory-leaks/) guide is the reference version of these steps, and the [profiler docs](/docs/profiler/) cover every command and setting.
