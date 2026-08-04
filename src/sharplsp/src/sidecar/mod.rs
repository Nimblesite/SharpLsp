//! Sidecar IPC module — manages .NET sidecar processes for semantic intelligence.
//!
//! Handles spawning, health monitoring, crash recovery, and message routing
//! to the C# (Roslyn) and F# (FCS) sidecar processes.

pub mod manager;
pub mod protocol;
pub mod transport;
