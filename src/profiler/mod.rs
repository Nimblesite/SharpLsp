//! Profiler integration — wraps `dotnet-trace`, `dotnet-counters`, and `dotnet-dump`.
//!
//! All profiler logic lives in the Rust LSP host. Diagnostic CLI tools are
//! spawned as child processes — no sidecar involvement.

pub mod counters;
pub mod dump;
pub mod dump_cmd;
pub mod handlers;
pub mod heap_analysis;
pub mod heap_diff;
pub mod object_graph;
pub mod object_inspection;
pub mod process_list;
pub mod session;
pub mod tool_discovery;
pub mod trace;
