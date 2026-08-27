//! `NuGet` package management — wraps the nuget.org API and `dotnet` CLI.
//!
//! All `NuGet` operations live in the Rust LSP host (Tier 1). The extension
//! is a thin UI shell that sends `sharplsp/nuget/*` custom requests.

pub mod cache;
pub mod cli;
pub mod consolidate;
pub mod edit;
pub mod handlers;
pub mod parse;
pub mod search;
pub mod targets;
pub mod types;
pub mod unused;
