//! A fake compiler on an in-memory stream: answers each request from a
//! closure and records what it received, for host tests of the sidecar session.
use std::sync::{Arc, Mutex};

use anyhow::Result;

use crate::sidecar::manager::SidecarManager;
use crate::sidecar::protocol::Envelope;
use crate::sidecar::transport::FramedTransport;
use crate::tree_sitter_parse::LangId;

/// Every request a fake compiler received, in order: method and payload.
pub(crate) type Received = Arc<Mutex<Vec<(String, Vec<u8>)>>>;
/// A fake compiler's answer to a request, given everything received so far.
pub(crate) type Answers = Arc<dyn Fn(&str, &[(String, Vec<u8>)]) -> Vec<u8> + Send + Sync>;

/// A host-side manager wired to a fake compiler that answers from `answers`.
pub(crate) struct Fake {
    pub(crate) manager: Arc<SidecarManager>,
    received: Received,
}

impl Fake {
    pub(crate) fn connect(runtime: &tokio::runtime::Runtime, answers: Answers) -> Self {
        Self::connect_as(runtime, LangId::CSharp, answers)
    }

    pub(crate) fn connect_as(
        runtime: &tokio::runtime::Runtime,
        language: LangId,
        answers: Answers,
    ) -> Self {
        let (host, compiler) = tokio::io::duplex(1 << 20);
        let received = Received::default();
        drop(runtime.spawn(answer(compiler, answers, Arc::clone(&received))));
        let manager =
            runtime.block_on(SidecarManager::compiler_on_stream_for_tests(host, language));
        Self {
            manager: Arc::new(manager),
            received,
        }
    }

    /// How many requests the compiler has received so far.
    pub(crate) fn mark(&self) -> Result<usize> {
        Ok(self.log()?.len())
    }

    /// The payloads of every `method` request received after `mark`.
    pub(crate) fn since(&self, mark: usize, method: &str) -> Result<Vec<Vec<u8>>> {
        Ok(self
            .log()?
            .iter()
            .skip(mark)
            .filter(|(name, _)| name == method)
            .map(|(_, payload)| payload.clone())
            .collect())
    }

    /// The workspaces opened after `mark`.
    pub(crate) fn opened(&self, mark: usize) -> Result<Vec<String>> {
        self.since(mark, "workspace/open")?
            .iter()
            .map(|payload| Ok(rmp_serde::from_slice(payload)?))
            .collect()
    }

    /// The files whose buffers were replayed after `mark`.
    pub(crate) fn replayed(&self, mark: usize) -> Result<Vec<String>> {
        self.since(mark, "textDocument/didChange")?
            .iter()
            .map(|payload| Ok(rmp_serde::from_slice::<(String, String)>(payload)?.0))
            .collect()
    }

    fn log(&self) -> Result<Vec<(String, Vec<u8>)>> {
        self.received
            .lock()
            .map(|log| log.clone())
            .map_err(|error| anyhow::anyhow!("fake compiler log poisoned: {error}"))
    }
}

/// Answer each request from `answers`, recording it first.
async fn answer(stream: tokio::io::DuplexStream, answers: Answers, received: Received) {
    let mut transport = FramedTransport::from_stream(stream);
    while let Ok(Some(request)) = transport.read_envelope().await {
        let method = request.method.clone().unwrap_or_default();
        let payload = received.lock().map_or_else(
            |_poisoned| Vec::new(),
            |mut log| {
                log.push((method.clone(), request.payload.clone()));
                answers(&method, &log)
            },
        );
        let response = Envelope {
            id: request.id,
            method: None,
            payload,
            error: None,
        };
        if transport.write_envelope(&response).await.is_err() {
            break;
        }
    }
}

/// An empty list, which every enumeration decodes as "nothing".
pub(crate) fn empty() -> Vec<u8> {
    rmp_serde::to_vec(&Vec::<u8>::new()).unwrap_or_default()
}

/// A compiler answering `workspace/diagnostics/documents` with `graph` and
/// every other request with nothing.
pub(crate) fn answering(graph: Vec<u8>) -> Answers {
    Arc::new(move |method, _| match method {
        "workspace/diagnostics/documents" => graph.clone(),
        _ => empty(),
    })
}
