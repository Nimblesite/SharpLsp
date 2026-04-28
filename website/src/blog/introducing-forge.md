---
layout: layouts/blog.njk
title: "Scaling the Forge Message Broker to 1M Events per Second"
description: "The architectural shifts and low-level Rust optimizations required to push Forge past the 1,000,000 EPS threshold on commodity hardware."
date: 2024-10-24
author: Jane Doe
tags:
  - posts
  - systems-engineering
  - rust
category: systems engineering
excerpt: "A detailed look into how we rewrote our core messaging infrastructure using Rust and a custom ring buffer architecture to achieve sub-millisecond latency at massive scale."
---

When we initially designed Forge, our internal message broker, the target was modest: handle 50,000 events per second with sub-10ms latency. As our microservices ecosystem exploded, that number quickly became a bottleneck. This post details the architectural shifts and low-level Rust optimizations required to push Forge past the 1,000,000 EPS threshold on commodity hardware.

## The Bottleneck: Lock Contention

Our initial v1 architecture relied heavily on standard `RwLock` primitives for managing partition state. While conceptually simple, profiling revealed catastrophic thread contention under heavy load. The CPU was spending more time context-switching and managing locks than actually moving bytes.

<figure class="article-figure">
  <img src="https://lh3.googleusercontent.com/aida-public/AB6AXuD-ap6VjPSfkymYONTBORgR7-FYubfHcxGVY5iSBkAQ99o2PmogkQ2_rkuS_pQ7OgoDGPTIB30Bbt3FKiCMeDtrg651pxOm1-Zc1JrQZ939G9Jw__mXYo2cLADu8-DzVP51_FV12tAWWaYQjmyCnD3XGhxx-HY2p8lNn7OCVWAN6tx2L-wa911fh_E6_5tLDie-qWhaMlujautjMm_GJTy03xEW1CYvvVfzukhtwTUPBCzcpj9INJrNdpdBX0EYhPDWbAjPozmtgQ" alt="Abstract technical diagram showing green data flows through network nodes">
  <figcaption>Figure 1: Lock contention profiling in Forge v1 vs v2.</figcaption>
</figure>

## Moving to Lock-Free Data Structures

The solution was entirely ripping out the shared mutable state. We transitioned to a lock-free ring buffer implementation for the core event ingestion pipeline. Using atomic operations provided a massive throughput boost, allowing threads to enqueue and dequeue events concurrently without blocking.

```rust
use std::sync::atomic::{AtomicUsize, Ordering};

pub struct RingBuffer<T> {
    buffer: Vec<T>,
    head: AtomicUsize,
    tail: AtomicUsize,
    capacity: usize,
}

impl<T> RingBuffer<T> {
    pub fn push(&mut self, item: T) -> Result<(), T> {
        let current_tail = self.tail.load(Ordering::Relaxed);
        let next_tail = (current_tail + 1) % self.capacity;

        if next_tail == self.head.load(Ordering::Acquire) {
            return Err(item);
        }

        self.buffer[current_tail] = item;
        self.tail.store(next_tail, Ordering::Release);
        Ok(())
    }
}
```

By enforcing strict memory ordering (`Acquire`/`Release` semantics), we ensure data visibility across threads without the heavy cost of mutexes. This single change yielded a 400% increase in baseline throughput.

## Zero-Copy Networking with io_uring

Getting data into memory fast is only half the battle; writing it to disk and pushing it back to network sockets is where latency spikes hide. We bypassed the standard epoll-based async runtimes in favor of direct `io_uring` integration for disk I/O and socket operations.

<aside class="article-note">
  <span class="material-symbols-outlined" aria-hidden="true">lightbulb</span>
  <div>
    <h3>Architecture Note</h3>
    <p>Integrating io_uring required bypassing standard Tokio primitives. We built a custom reactor tailored specifically for Forge's I/O patterns, sacrificing general-purpose utility for raw speed.</p>
  </div>
</aside>

The results speak for themselves. The 99th percentile latency dropped from 12ms to 1.8ms under 80% peak load. The system now easily sustains 1.2M EPS before hitting network interface card (NIC) saturation.
