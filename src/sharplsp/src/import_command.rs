//! `sharplsp.addReferenceAndImport`: the command behind a quick fix that brings
//! a name in from outside its project's references — another project of the
//! solution, or a package. The action's own edit adds the import; the client
//! then runs this command, and the host adds the reference through the
//! `MSBuild` DOM. A reference that cannot be added fails the command with the reason,
//! never silently. [REFACTOR-IMPORT-REFERENCE] [REFACTOR-NEVER-SILENT]

use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use crossbeam_channel::Sender;
use lsp_server::{Message, Request};
use lsp_types::Command;
use serde_json::{json, Value};
use tokio::runtime::Runtime;
use tracing::{info, warn};

use crate::nuget::{edit, handlers, search};
use crate::sidecar::manager::SidecarManager;

/// The command name the server advertises and the client sends back.
pub const COMMAND: &str = "sharplsp.addReferenceAndImport";

/// The reference kind for another project of the solution.
const PROJECT: &str = "project";
/// The reference kind for a `NuGet` package.
const PACKAGE: &str = "package";

/// The reference a sidecar's command action adds after its import. Positional
/// `MessagePack` from the sidecars' `ReferenceImport` `[Key(0..3)]`; camel-cased
/// JSON in the command's arguments.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarReferenceImport {
    /// `project` or `package`.
    pub kind: String,
    /// Absolute path of the project file that gains the reference.
    pub project_path: String,
    /// The referenced project's absolute path, or the package id.
    pub reference: String,
    /// The package version; empty for a project or the latest stable package.
    pub version: String,
}

/// The command's one argument: the action's title, for messages, and its reference.
#[derive(Debug, serde::Deserialize)]
struct ImportArguments {
    /// The quick fix's title, as the user chose it.
    title: String,
    /// The reference to add.
    reference: SidecarReferenceImport,
}

/// The LSP command that adds `reference` once the import of action `data`
/// (`{id, uri}`) is applied.
pub fn command(title: &str, data: &Value, reference: &SidecarReferenceImport) -> Command {
    Command {
        title: title.to_string(),
        command: COMMAND.to_string(),
        arguments: Some(vec![
            json!({ "title": title, "action": data, "reference": reference }),
        ]),
    }
}

/// Whether `req` runs this command.
pub fn is_import_command(req: &Request) -> bool {
    req.method == "workspace/executeCommand"
        && req.params.get("command").and_then(Value::as_str) == Some(COMMAND)
}

/// Run the command: add the reference its action names, and say what changed.
pub fn handle(
    req: &Request,
    runtime: &Runtime,
    sender: Sender<Message>,
    csharp: Option<&Arc<SidecarManager>>,
) -> Result<Value> {
    let arguments = arguments(&req.params)?;
    let reference = &arguments.reference;
    info!(title = %arguments.title, kind = %reference.kind, project = %reference.project_path, reference = %reference.reference, "Handling sharplsp.addReferenceAndImport");
    let sidecar = csharp.ok_or_else(|| {
        anyhow!("the C# language service, which edits project files, is not running")
    })?;
    let message = add_reference(sidecar, runtime, sender, reference).inspect_err(|error| {
        warn!(title = %arguments.title, error = %format_args!("{error:#}"), "reference not added");
    })?;
    Ok(json!({ "message": message }))
}

/// The command's argument, or an error that names what is missing.
fn arguments(params: &Value) -> Result<ImportArguments> {
    let argument = params
        .get("arguments")
        .and_then(Value::as_array)
        .and_then(|arguments| arguments.first())
        .context("sharplsp.addReferenceAndImport needs one argument: { title, reference }")?;
    serde_json::from_value(argument.clone())
        .context("sharplsp.addReferenceAndImport: malformed { title, reference } argument")
}

/// Add the project or package reference; the message says what changed.
fn add_reference(
    sidecar: &Arc<SidecarManager>,
    runtime: &Runtime,
    sender: Sender<Message>,
    reference: &SidecarReferenceImport,
) -> Result<String> {
    match reference.kind.as_str() {
        PROJECT => add_project(sidecar, runtime, reference),
        PACKAGE => add_package(sidecar, runtime, sender, reference),
        other => bail!("unknown reference kind {other:?}: expected project or package"),
    }
}

/// Reference another project of the solution.
fn add_project(
    sidecar: &Arc<SidecarManager>,
    runtime: &Runtime,
    reference: &SidecarReferenceImport,
) -> Result<String> {
    let outcome = edit::add_project_reference(
        sidecar,
        runtime,
        &reference.project_path,
        &reference.reference,
    )?;
    Ok(outcome.message)
}

/// Install the package at its version, or at the latest stable one.
fn add_package(
    sidecar: &Arc<SidecarManager>,
    runtime: &Runtime,
    sender: Sender<Message>,
    reference: &SidecarReferenceImport,
) -> Result<String> {
    let version = match reference.version.as_str() {
        "" => runtime.block_on(search::latest_stable(&reference.reference))?,
        pinned => pinned.to_string(),
    };
    let response = handlers::install_into_project(
        sidecar,
        runtime,
        sender,
        &reference.project_path,
        &reference.reference,
        &version,
    )?;
    if !response.success {
        bail!(
            "could not add {} {version}: {}",
            reference.reference,
            response.message
        );
    }
    Ok(format!(
        "Added {} {version}; restoring in the background",
        reference.reference
    ))
}
