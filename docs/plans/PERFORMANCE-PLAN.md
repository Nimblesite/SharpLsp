# Performance Plan

Performance targets and benchmarking.

## Optimization

- [ ] Performance optimization pass (memory budgets, cache eviction, lazy loading)

## Latency Targets

- [ ] Cold start < 3 seconds to first LSP response
- [ ] Warm completion latency < 100ms p50, < 200ms p95
- [ ] Hover latency < 150ms p50
- [ ] Find references (1000-file solution) < 2 seconds

## Memory Targets

- [ ] Memory < 2GB Rust + < 3GB sidecar (600K LOC solution)

## Hover Benchmarks

- [ ] Benchmark hover latency on cold start (first hover after project load)
- [ ] Benchmark hover latency on warm cache (repeated hover on same position)
- [ ] Benchmark hover latency on large solution (~2M LOC)
- [ ] Validate tree-sitter pre-validation rejects non-symbol positions in <1ms
- [ ] Profile sidecar memory usage during sustained hover requests
