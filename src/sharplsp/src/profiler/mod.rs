//! Profiling: the shared `lsp-profiler` engine mounted in this host.
//! Implements [PROFILER-SHARED-LIBRARY].
//!
//! Every profiling decision — processes, CPU sampling, heap snapshots, leak
//! scoring, exports — lives in `lsp-profiler` and its .NET runtime. This
//! module only mounts the service on the LSP connection.

pub mod host;
