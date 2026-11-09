//! Push-pipeline tests: generation gate, provisional convergence, source tags. [DIAG-PUSH-GATE]
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "test code — panics are the correct failure mode"
)]

use super::*;

/// Razor diagnostics publish under their own source, whether the file is
/// named by URI (push) or by path (pull and solution-wide).
/// [RAZOR-ARCHITECTURE-ROUTING]
#[test]
fn razor_files_publish_under_the_razor_source() {
    let component: Uri = "file:///c:/app/Board.razor".parse().unwrap();
    let view: Uri = "file:///c:/app/Index.cshtml".parse().unwrap();
    let code: Uri = "file:///c:/app/Program.cs".parse().unwrap();
    assert_eq!(source_tag_for_uri(&component), "sharplsp-razor");
    assert_eq!(source_tag_for_uri(&view), "sharplsp-razor");
    assert_eq!(source_tag_for_uri(&code), "sharplsp-csharp");
    assert_eq!(
        source_tag_for_path("/app/Pages/Board.razor"),
        "sharplsp-razor"
    );
    assert_eq!(
        source_tag_for_path("/app/Views/Index.CSHTML"),
        "sharplsp-razor"
    );
    assert_eq!(source_tag_for_path("/app/Library.fs"), "sharplsp-fsharp");
}

#[test]
fn map_severity_error() {
    assert_eq!(map_severity("Error"), DiagnosticSeverity::ERROR);
}

#[test]
fn map_severity_warning() {
    assert_eq!(map_severity("Warning"), DiagnosticSeverity::WARNING);
}

#[test]
fn map_severity_info() {
    assert_eq!(map_severity("Info"), DiagnosticSeverity::INFORMATION);
}

#[test]
fn map_severity_unknown_falls_back_to_hint() {
    assert_eq!(map_severity("Nonsense"), DiagnosticSeverity::HINT);
    assert_eq!(map_severity(""), DiagnosticSeverity::HINT);
}

#[test]
fn to_lsp_diagnostic_maps_all_fields() {
    let input = SidecarDiagnostic {
        _file_path: "/src/main.cs".to_string(),
        start_line: 10,
        start_character: 4,
        end_line: 10,
        end_character: 20,
        message: "Unused variable".to_string(),
        severity: "Warning".to_string(),
        code: "CS0219".to_string(),
        help_link:
            "https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1822"
                .to_string(),
    };

    let diag = to_lsp_diagnostic(input, "sharplsp-csharp");

    assert_eq!(diag.range.start, Position::new(10, 4));
    assert_eq!(diag.range.end, Position::new(10, 20));
    assert_eq!(diag.severity, Some(DiagnosticSeverity::WARNING));
    assert_eq!(
        diag.code,
        Some(NumberOrString::String("CS0219".to_string()))
    );
    // The rule's documentation link reaches the editor as codeDescription.href
    // ([DIAG-CATEGORIES-ANALYZER]).
    assert_eq!(
        diag.code_description.as_ref().map(|it| it.href.as_str()),
        Some("https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1822")
    );
    assert_eq!(diag.source, Some("sharplsp-csharp".to_string()));
    assert_eq!(diag.message, "Unused variable");
}

/// A sidecar answer without a help link — F# compiler and built-in analyzer
/// diagnostics, and any older sidecar — must decode and publish without a
/// codeDescription.
#[test]
fn to_lsp_diagnostic_without_help_link_has_no_code_description() {
    let input = SidecarDiagnostic {
        _file_path: "/src/main.fs".to_string(),
        start_line: 1,
        start_character: 0,
        end_line: 1,
        end_character: 4,
        message: "Unnecessary open".to_string(),
        severity: "Info".to_string(),
        code: "IDE0005".to_string(),
        help_link: String::new(),
    };

    let diag = to_lsp_diagnostic(input, "sharplsp-fsharp");

    assert_eq!(diag.code_description, None);
}

/// An F# `FSharpLint` finding carries its rule's stable documentation page
/// through the same host mapping ([DIAG-CATEGORIES-ANALYZER]).
#[test]
fn to_lsp_diagnostic_maps_fsharp_lint_help_link() {
    let input = SidecarDiagnostic {
        _file_path: "/src/main.fs".to_string(),
        start_line: 2,
        start_character: 0,
        end_line: 2,
        end_character: 4,
        message: "Consider using <> instead of =.".to_string(),
        severity: "Warning".to_string(),
        code: "FL0065".to_string(),
        help_link: "https://fsprojects.github.io/FSharpLint/how-tos/rules/FL0065.html".to_string(),
    };

    let diag = to_lsp_diagnostic(input, "sharplsp-fsharp");

    assert_eq!(
        diag.code_description.as_ref().map(|it| it.href.as_str()),
        Some("https://fsprojects.github.io/FSharpLint/how-tos/rules/FL0065.html")
    );
}

#[test]
fn publish_sends_notification() {
    let (sender, receiver) = crossbeam_channel::unbounded();
    let uri: Uri = "file:///tmp/test.cs".parse().unwrap();
    let diag = Diagnostic {
        message: "test diagnostic".to_string(),
        ..Diagnostic::default()
    };

    publish(&sender, uri.clone(), vec![diag]).unwrap();

    let params = next_publish(&receiver);
    assert_eq!(params.uri, uri);
    assert_eq!(params.diagnostics.len(), 1);
    assert_eq!(params.diagnostics[0].message, "test diagnostic");
    assert!(params.version.is_none());
}

/// [GitHub #160] Phantom-diagnostics repro at the push-pipeline level.
///
/// Timeline mirroring the `FsToolkit` e2e: an edit introduces a type error
/// (fetch #1 → Error diagnostic published), the user reverts the edit, and
/// the revert-triggered fetch #2 FAILS transiently (timeout / respawn /
/// transport hiccup). The revert is the last edit, so nothing else will
/// ever re-trigger a push — the pipeline itself must converge: a failed
/// fetch for the newest text must be retried until the latest generation
/// is published, never dropped. Dropping it strands the stale Error in the
/// editor's push collection forever, exactly the "error never clears"
/// symptom of #160.
#[test]
fn failed_fetch_after_revert_must_not_strand_stale_published_diagnostics() {
    // Scripted sidecar: #1 → error diagnostic (broken text), #2 → transient
    // failure (the post-revert fetch), #3.. → clean (the reverted text).
    let error_payload = rmp_serde::to_vec(&vec![(
        "X.fs".to_string(),
        0u32,
        0u32,
        0u32,
        5u32,
        "type mismatch".to_string(),
        "Error".to_string(),
        "FS0001".to_string(),
    )])
    .unwrap();
    let ScriptedHost {
        runtime,
        manager,
        sender,
        receiver,
    } = scripted_host(Some(error_payload));
    let uri: Uri = "file:///x.fs".parse().unwrap();

    // Edit 1: broken text — the error surfaces (repro precondition).
    request_in_background(
        &runtime,
        Arc::clone(&manager),
        sender.clone(),
        uri.clone(),
        "X.fs".to_string(),
    );
    let first = recv_publication(&receiver, std::time::Duration::from_secs(10));
    assert_eq!(
        first.diagnostics.len(),
        1,
        "the broken text must publish its error"
    );

    // Edit 2: the revert — this fetch fails transiently. The pipeline must
    // keep retrying for the newest text and publish the clean result.
    request_in_background(&runtime, manager, sender, uri, "X.fs".to_string());
    let converged = recv_publication(&receiver, std::time::Duration::from_secs(10));
    assert!(
        converged.diagnostics.is_empty(),
        "after the revert the pipeline must converge to a clean publication \
         even when a fetch fails transiently — stale errors published for \
         older text must never remain the final state (GitHub #160); got: {:?}",
        converged
            .diagnostics
            .iter()
            .map(|d| &d.message)
            .collect::<Vec<_>>()
    );
}

/// A file-based app opens on tier-2 BCL references while `dotnet restore`
/// runs, so its first diagnostic set is a placeholder carrying phantom
/// `CS0246`s next to the `SLSPC0002` restore-pending notice. The tier-1
/// upgrade then swaps the project's references inside the sidecar — an
/// event the editor cannot observe, and one no further `didChange` follows
/// when the user is simply reading the file. The push pipeline itself must
/// therefore keep fetching until the provisional set settles; otherwise the
/// placeholder's errors stay on screen for the life of the document even
/// though hover and completion already bind the restored package.
/// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
#[test]
fn provisional_filebased_set_must_be_republished_once_restore_settles() {
    let pending_payload = rmp_serde::to_vec(&vec![
        (
            "App.cs".to_string(),
            1u32,
            6u32,
            1u32,
            16u32,
            "The type or namespace name 'JObject' could not be found".to_string(),
            "Error".to_string(),
            "CS0246".to_string(),
        ),
        (
            "App.cs".to_string(),
            0u32,
            0u32,
            0u32,
            1u32,
            "File-based package restore degraded to BCL-only references: \
             Restore pending for Newtonsoft.Json@13.0.3."
                .to_string(),
            "Info".to_string(),
            RESTORE_PENDING_CODE.to_string(),
        ),
    ])
    .unwrap();
    let ScriptedHost {
        runtime,
        manager,
        sender,
        receiver,
    } = scripted_host(Some(pending_payload));
    let uri: Uri = "file:///app.cs".parse().unwrap();

    // One didOpen — the only client event this document ever gets.
    request_in_background(&runtime, manager, sender, uri, "App.cs".to_string());

    let provisional = recv_publication(&receiver, std::time::Duration::from_secs(10));
    assert!(
        has_restore_pending(&provisional.diagnostics),
        "tier 2 must publish its restore-pending notice immediately"
    );
    assert_eq!(
        provisional.diagnostics.len(),
        2,
        "the placeholder set carries the unresolved package error too"
    );

    let settled = recv_publication(&receiver, std::time::Duration::from_secs(10));
    assert!(
        settled.diagnostics.is_empty(),
        "the tier-1 upgrade must be republished without any further client \
         event — a provisional set is never the final published state; got: {:?}",
        settled
            .diagnostics
            .iter()
            .map(|d| &d.message)
            .collect::<Vec<_>>()
    );
}

/// A semantic response for a document whose latest publication is a
/// provisional tier-2 placeholder must be preceded by a corrected
/// publication: the response path calls [`converge_provisional`] before
/// the answer is sent, and that call must re-fetch and republish. Without
/// it, completion can reveal the restored package while the placeholder's
/// phantom `CS0246`s stay published until the push loop's next 1s tick —
/// the window the file-based add/remove/re-add e2e failed in.
/// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK] and [DIAG-PUSH-GATE].
#[test]
fn provisional_publication_is_converged_before_a_semantic_response() {
    let ScriptedHost {
        runtime,
        manager,
        sender,
        receiver,
    } = scripted_host(None);
    let uri: Uri = "file:///converge.cs".parse().unwrap();
    let generation = next_generation(&uri);
    let provisional = vec![Diagnostic {
        code: Some(NumberOrString::String(RESTORE_PENDING_CODE.to_string())),
        message: "Restore pending for Newtonsoft.Json@13.0.3.".to_string(),
        ..Diagnostic::default()
    }];
    assert!(publish_if_current(&sender, &uri, generation, provisional).unwrap());
    let placeholder = recv_publication(&receiver, std::time::Duration::from_secs(5));
    assert!(has_restore_pending(&placeholder.diagnostics));
    assert!(published_set_is_provisional(&uri));

    runtime.block_on(converge_provisional(&manager, &sender, &uri, "Converge.cs"));

    let corrected = recv_publication(&receiver, std::time::Duration::from_secs(5));
    assert!(
        corrected.diagnostics.is_empty(),
        "the convergence fetch must republish the settled set before the \
         semantic response is sent"
    );
    assert!(
        !published_set_is_provisional(&uri),
        "a settled publication must clear the provisional flag"
    );

    // Steady state: a non-provisional publication needs no convergence.
    runtime.block_on(converge_provisional(&manager, &sender, &uri, "Converge.cs"));
    assert!(
        receiver
            .recv_timeout(std::time::Duration::from_millis(200))
            .is_err(),
        "convergence after a settled publication must be a no-op"
    );
}

/// A competing push cannot make a framework switch's synchronous fetch
/// disappear before its required publication. [NETFX-CONTEXT] [DIAG-PUSH-GATE]
#[test]
fn superseded_first_push_retries_until_it_publishes() {
    let host = scripted_host(None);
    let uri: Uri = "file:///framework.cs".parse().unwrap();
    let generation = next_generation(&uri);
    let _competing = next_generation(&uri);
    let target = (host.manager, uri, "Framework.cs".to_string());

    let unfinished = host
        .runtime
        .block_on(first_push(target, generation, host.sender));

    assert!(unfinished.is_none());
    assert_eq!(
        recv_publication(&host.receiver, Duration::from_secs(5)).diagnostics,
        []
    );
}

/// A host connected to a scripted fake sidecar, and the channel the push
/// pipeline publishes on.
struct ScriptedHost {
    runtime: tokio::runtime::Runtime,
    manager: Arc<crate::sidecar::manager::SidecarManager>,
    sender: crossbeam_channel::Sender<Message>,
    receiver: crossbeam_channel::Receiver<Message>,
}

/// Connect a host to [`fake_scripted_sidecar`], whose first answer is
/// `first` (a clean set when `None`) and whose later answers are clean.
fn scripted_host(first: Option<Vec<u8>>) -> ScriptedHost {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (host_side, sidecar_side) = tokio::io::duplex(64 * 1024);
    let manager = runtime.block_on(async {
        Arc::new(
            crate::sidecar::manager::SidecarManager::connected_to_stream_for_tests(host_side).await,
        )
    });
    let clean = rmp_serde::to_vec::<Vec<i32>>(&vec![]).unwrap();
    let first = first.unwrap_or_else(|| clean.clone());
    drop(runtime.spawn(fake_scripted_sidecar(sidecar_side, first, clean)));
    let (sender, receiver) = crossbeam_channel::unbounded();
    ScriptedHost {
        runtime,
        manager,
        sender,
        receiver,
    }
}

/// Scripted in-memory sidecar: response #1 carries `error_payload`,
/// response #2 is a transient envelope error, responses #3+ carry
/// `clean_payload`.
async fn fake_scripted_sidecar(
    stream: tokio::io::DuplexStream,
    error_payload: Vec<u8>,
    clean_payload: Vec<u8>,
) {
    let mut transport = crate::sidecar::transport::FramedTransport::from_stream(stream);
    let mut request_count = 0u32;
    while let Ok(Some(request)) = transport.read_envelope().await {
        request_count += 1;
        let response = match request_count {
            1 => crate::sidecar::protocol::Envelope {
                id: request.id,
                method: None,
                payload: error_payload.clone(),
                error: None,
            },
            2 => crate::sidecar::protocol::Envelope {
                id: request.id,
                method: None,
                payload: Vec::new(),
                error: Some("transient transport failure".to_string()),
            },
            _ => crate::sidecar::protocol::Envelope {
                id: request.id,
                method: None,
                payload: clean_payload.clone(),
                error: None,
            },
        };
        if transport.write_envelope(&response).await.is_err() {
            break;
        }
    }
}

/// Receive the next `publishDiagnostics` notification within `timeout`.
fn recv_publication(
    receiver: &crossbeam_channel::Receiver<Message>,
    timeout: std::time::Duration,
) -> PublishDiagnosticsParams {
    match receiver.recv_timeout(timeout) {
        Ok(Message::Notification(n)) => {
            assert_eq!(n.method, "textDocument/publishDiagnostics");
            serde_json::from_value(n.params).unwrap()
        }
        Ok(other) => panic!("expected publishDiagnostics notification, got {other:?}"),
        Err(err) => panic!(
            "no publishDiagnostics arrived within {timeout:?} ({err}) — the pipeline \
             dropped the publication and stale diagnostics remain (GitHub #160)"
        ),
    }
}

#[test]
fn clear_sends_empty_diagnostics() {
    let (sender, receiver) = crossbeam_channel::unbounded();
    let uri: Uri = "file:///tmp/test.cs".parse().unwrap();

    clear(&sender, uri.clone()).unwrap();

    let params = next_publish(&receiver);
    assert_eq!(params.uri, uri);
    assert!(
        matches!(params.diagnostics.as_slice(), []),
        "{:?}",
        params.diagnostics
    );
}

/// The next message on the wire, proven to be a `publishDiagnostics` push.
fn next_publish(receiver: &crossbeam_channel::Receiver<Message>) -> PublishDiagnosticsParams {
    match receiver.recv().unwrap() {
        Message::Notification(n) => {
            assert_eq!(n.method, "textDocument/publishDiagnostics");
            serde_json::from_value(n.params).unwrap()
        }
        msg => panic!("expected Notification, got {msg:?}"),
    }
}
