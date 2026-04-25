//! LSP custom request handlers for profiler operations.
//!
//! All handlers follow the pattern: deserialize params → delegate to module → serialize result.

use anyhow::Result;
use lsp_server::{Message, Request};
use tracing::info;

use super::{
    counters, dump, heap_analysis, heap_diff, object_graph, object_inspection, process_list, trace,
};

/// Handle `forge/profiler/listProcesses`.
pub fn handle_list_processes(req: Request) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/listProcesses");
    let _params: serde_json::Value = serde_json::from_value(req.params)?;
    let processes = process_list::list()?;
    Ok(serde_json::to_value(processes)?)
}

/// Handle `forge/profiler/startTrace`.
pub fn handle_start_trace(req: Request) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/startTrace");
    let params: trace::StartTraceParams = serde_json::from_value(req.params)?;
    let result = trace::start(params)?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `forge/profiler/stopTrace`.
pub fn handle_stop_trace(req: Request) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/stopTrace");
    let params: StopSessionParams = serde_json::from_value(req.params)?;
    let result = trace::stop(&params.session_id)?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `forge/profiler/convertTrace`.
pub fn handle_convert_trace(req: Request) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/convertTrace");
    let params: trace::ConvertTraceParams = serde_json::from_value(req.params)?;
    let result = trace::convert(&params)?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `forge/profiler/startCounters`.
pub fn handle_start_counters(
    req: Request,
    sender: crossbeam_channel::Sender<Message>,
) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/startCounters");
    let params: counters::StartCountersParams = serde_json::from_value(req.params)?;
    let result = counters::start(&params, sender)?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `forge/profiler/stopCounters`.
pub fn handle_stop_counters(req: Request) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/stopCounters");
    let params: StopSessionParams = serde_json::from_value(req.params)?;
    counters::stop(&params.session_id)?;
    Ok(serde_json::Value::Null)
}

/// Handle `forge/profiler/collectDump`.
pub fn handle_collect_dump(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sender: crossbeam_channel::Sender<Message>,
) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/collectDump");
    let params: dump::CollectDumpParams = serde_json::from_value(req.params)?;
    let result = runtime.block_on(dump::collect(params, sender))?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `forge/profiler/analyzeHeap`.
pub fn handle_analyze_heap(
    req: Request,
    runtime: &tokio::runtime::Runtime,
) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/analyzeHeap");
    let params: heap_analysis::AnalyzeHeapParams = serde_json::from_value(req.params)?;
    let result = runtime.block_on(heap_analysis::analyze_heap(params))?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `forge/profiler/findGCRoots`.
pub fn handle_find_gc_roots(
    req: Request,
    runtime: &tokio::runtime::Runtime,
) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/findGCRoots");
    let params: heap_analysis::FindGcRootsParams = serde_json::from_value(req.params)?;
    let result = runtime.block_on(heap_analysis::find_gc_roots(params))?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `forge/profiler/inspectObject`.
pub fn handle_inspect_object(
    req: Request,
    runtime: &tokio::runtime::Runtime,
) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/inspectObject");
    let params: object_inspection::InspectObjectParams = serde_json::from_value(req.params)?;
    let result = runtime.block_on(object_inspection::inspect(params))?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `forge/profiler/diffHeapSnapshots`.
pub fn handle_diff_heap_snapshots(
    req: Request,
    runtime: &tokio::runtime::Runtime,
) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/diffHeapSnapshots");
    let params: heap_diff::DiffHeapSnapshotsParams = serde_json::from_value(req.params)?;
    let result = runtime.block_on(heap_diff::diff_snapshots(params))?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `forge/profiler/getObjectGraph`.
pub fn handle_get_object_graph(
    req: Request,
    runtime: &tokio::runtime::Runtime,
) -> Result<serde_json::Value> {
    info!("Handling forge/profiler/getObjectGraph");
    let params: object_graph::GetObjectGraphParams = serde_json::from_value(req.params)?;
    let result = runtime.block_on(object_graph::get_object_graph(params))?;
    Ok(serde_json::to_value(result)?)
}

/// Wire type for stopping a profiler session (trace or counters).
#[derive(serde::Deserialize)]
struct StopSessionParams {
    /// Identifier of the session to stop.
    session_id: String,
}
