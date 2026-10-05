//! LSP custom request handlers for profiler operations. Implements [PROFILER-PROTOCOL].
//!
//! All handlers follow the pattern: deserialize params → delegate to module → serialize result.

use anyhow::Result;
use lsp_server::{Message, Request};
use std::{future::Future, pin::Pin};
use tracing::info;

use super::{
    counters, dump, heap_analysis, heap_diff, object_graph, object_inspection, process_list, trace,
};

/// Handle `sharplsp/profiler/listProcesses`.
pub fn handle_list_processes(req: Request) -> Result<serde_json::Value> {
    info!("Handling sharplsp/profiler/listProcesses");
    let _params: serde_json::Value = serde_json::from_value(req.params)?;
    let processes = process_list::list()?;
    Ok(serde_json::to_value(processes)?)
}

/// Handle `sharplsp/profiler/killProcess`.
pub fn handle_kill_process(req: Request) -> Result<serde_json::Value> {
    let params: KillProcessParams = serde_json::from_value(req.params)?;
    info!("Handling sharplsp/profiler/killProcess pid={}", params.pid);
    process_list::kill(params.pid)?;
    Ok(serde_json::json!({ "killed": true, "pid": params.pid }))
}

/// Handle `sharplsp/profiler/startTrace`.
pub fn handle_start_trace(req: Request) -> Result<serde_json::Value> {
    info!("Handling sharplsp/profiler/startTrace");
    let params: trace::StartTraceParams = serde_json::from_value(req.params)?;
    let result = trace::start(params)?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `sharplsp/profiler/stopTrace`.
pub fn handle_stop_trace(req: Request) -> Result<serde_json::Value> {
    info!("Handling sharplsp/profiler/stopTrace");
    let params: StopSessionParams = serde_json::from_value(req.params)?;
    let result = trace::stop(&params.session_id)?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `sharplsp/profiler/convertTrace`.
pub fn handle_convert_trace(req: Request) -> Result<serde_json::Value> {
    info!("Handling sharplsp/profiler/convertTrace");
    let params: trace::ConvertTraceParams = serde_json::from_value(req.params)?;
    let result = trace::convert(&params)?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `sharplsp/profiler/startCounters`.
pub fn handle_start_counters(
    req: Request,
    sender: crossbeam_channel::Sender<Message>,
) -> Result<serde_json::Value> {
    info!("Handling sharplsp/profiler/startCounters");
    let params: counters::StartCountersParams = serde_json::from_value(req.params)?;
    let result = counters::start(&params, sender)?;
    Ok(serde_json::to_value(result)?)
}

/// Handle `sharplsp/profiler/stopCounters`.
pub fn handle_stop_counters(req: Request) -> Result<serde_json::Value> {
    info!("Handling sharplsp/profiler/stopCounters");
    let params: StopSessionParams = serde_json::from_value(req.params)?;
    counters::stop(&params.session_id)?;
    Ok(serde_json::Value::Null)
}

/// A diagnostic operation whose child tool is stopped when the future is dropped.
pub(super) type Operation = Pin<Box<dyn Future<Output = Result<serde_json::Value>> + Send>>;

/// Route long profiler work off the message loop. Implements [PROFILER-PERFORMANCE].
pub(super) fn analysis(
    req: &Request,
    sender: crossbeam_channel::Sender<Message>,
) -> Option<Operation> {
    let params = req.params.clone();
    Some(match req.method.as_str() {
        "sharplsp/profiler/collectDump" => prepare(params, move |p| dump::collect(p, sender)),
        "sharplsp/profiler/analyzeHeap" => prepare(params, heap_analysis::analyze_heap),
        "sharplsp/profiler/findGCRoots" => prepare(params, heap_analysis::find_gc_roots),
        "sharplsp/profiler/inspectObject" => prepare(params, object_inspection::inspect),
        "sharplsp/profiler/diffHeapSnapshots" => prepare(params, heap_diff::diff_snapshots),
        "sharplsp/profiler/getObjectGraph" => prepare(params, object_graph::get_object_graph),
        _ => return None,
    })
}

/// Shared decoding and serialization for every asynchronous diagnostic request.
fn prepare<P, T, F, Fut>(params: serde_json::Value, run: F) -> Operation
where
    P: serde::de::DeserializeOwned + Send + 'static,
    T: serde::Serialize,
    F: FnOnce(P) -> Fut + Send + 'static,
    Fut: Future<Output = Result<T>> + Send + 'static,
{
    Box::pin(async move {
        Ok(serde_json::to_value(
            run(serde_json::from_value(params)?).await?,
        )?)
    })
}

/// Wire type for stopping a profiler session (trace or counters).
#[derive(serde::Deserialize)]
struct StopSessionParams {
    /// Identifier of the session to stop.
    session_id: String,
}

/// Wire type for `sharplsp/profiler/killProcess`.
#[derive(serde::Deserialize)]
struct KillProcessParams {
    /// PID of the .NET process to terminate.
    pid: u32,
}
