//! Existing LSP client and verified compiler ownership. [DIAG-ANALYSIS-CANCELLATION]
use super::*;
use fixture::Fixture;
use std::io::BufRead;
use workspace_diagnostic_protocol::recovery::{owned_apphost, published_apphost_uri};
use workspace_diagnostic_support::{assert_no_push, completed_pull, observed_request};

mod selection;

pub struct Session<'a> {
    /// The real SDK workspace outlives the owned server.
    fixture: &'a Fixture,
    /// Canonical client, never a replacement server or backend.
    client: LspClient,
    /// Raw observed traffic is test evidence, including the cancelled terminal reply.
    traffic: Vec<Value>,
    /// Every asynchronous request must have exactly one terminal through stdout EOF.
    requests: Vec<i32>,
}

impl<'a> Session<'a> {
    /// Await the single automatic workspace load before installing request interest.
    pub fn new(fixture: &'a Fixture) -> Self {
        let client = Self::launch(fixture);
        let mut session = Self {
            fixture,
            client,
            traffic: Vec::new(),
            requests: Vec::new(),
        };
        session.await_initialized();
        session
    }

    /// The real workspace root loads once; later explicit selections exercise replacement.
    fn launch(fixture: &Fixture) -> LspClient {
        let mut client = LspClient::spawn_in(Stdio::inherit(), Some(fixture.root()));
        let initialized = client.initialize_with_capabilities(json!(path_to_file_uri(fixture.root())),
            json!({"textDocument":{"diagnostic":{}},"workspace":{"diagnostics":{"refreshSupport":true}}}));
        assert_rpc_ok(&initialized, "initialize actual Roslyn compiler");
        client
    }

    /// A real load acknowledgement precedes compiler readiness pulls.
    fn load(&mut self) {
        self.select(self.fixture);
    }

    /// Loading acknowledges scheduling; the real compiler completion notification gates analysis.
    fn await_initialized(&mut self) {
        let deadline = Instant::now() + Duration::from_mins(1);
        while !self
            .traffic
            .iter()
            .any(|message| message["method"] == "workspace/projectInitializationComplete")
        {
            assert!(
                Instant::now() < deadline,
                "real compiler workspace did not initialize"
            );
            self.pump();
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Existing recovery helpers verify executable and parent process identity.
    pub fn compiler(&self) -> sysinfo::Pid {
        let key = if self.fixture.fsharp {
            "SHARPLSP_FSHARP_SIDECAR_PATH"
        } else {
            "SHARPLSP_CSHARP_SIDECAR_PATH"
        };
        let uri = published_apphost_uri(key, "published real compiler apphost");
        owned_apphost(&self.client, &uri, "exactly one owned real compiler")
    }

    /// Both native token observations and the still-running compiler match the original.
    pub fn assert_compiler(&self, original: sysinfo::Pid) {
        assert_eq!(
            self.compiler(),
            original,
            "a compiler restart cannot rescue cancellation"
        );
        if !self.fixture.fsharp {
            assert_eq!(self.read_signal("entered"), original.as_u32());
            assert_eq!(self.read_signal("cancelled"), original.as_u32());
        }
    }

    /// Retry only explicit supersession; inspect the first successful real compiler report.
    pub fn pull(&mut self, expected: Option<&str>, previous: Option<&str>) -> String {
        self.pull_uri(self.fixture.uri(), expected, previous)
    }

    /// All selected documents use the existing real compiler report and exact truth oracle.
    fn pull_uri(&mut self, uri: String, expected: Option<&str>, previous: Option<&str>) -> String {
        let report = completed_pull(
            &mut self.client,
            "textDocument/diagnostic",
            json!({"textDocument":{"uri":uri}}),
            &mut self.traffic,
        );
        let id = assertions::report(&report, expected, previous, self.fixture.tag());
        assert_no_push(&self.traffic);
        id
    }

    /// The real compiler's hover over `value`, which every fixture source declares at 2:4.
    pub fn hover_value(&mut self) -> String {
        let reply = observed_request(
            &mut self.client,
            "textDocument/hover",
            hover_params(&self.fixture.uri(), 2, 4),
            &mut self.traffic,
        );
        reply["result"]["contents"]["value"]
            .as_str()
            .expect("a markdown hover")
            .to_owned()
    }

    /// Cancellation must be observed inside the actual project analyzer before proceeding.
    pub fn cancel_analyzer(&mut self, compiler: sysinfo::Pid) -> i32 {
        let id = self.begin_analyzer(compiler, None);
        self.request_cancel(id);
        self.analyzer_cancelled_by_client(compiler, id);
        id
    }

    /// Enter the same genuine analyzer with an optional actual cached compiler identity.
    pub fn begin_analyzer(&mut self, compiler: sysinfo::Pid, previous: Option<&str>) -> i32 {
        self.arm_and_open();
        let id = match previous {
            Some(previous) => self.begin_fresh_pull(previous),
            None => self.begin_pull(),
        };
        assert_eq!(
            self.wait_signal("entered", Some(Self::pump)),
            compiler.as_u32()
        );
        id
    }

    /// An input notification must reach the analyzer token before any fresh pull is sent.
    pub fn analyzer_superseded(&mut self, compiler: sysinfo::Pid, id: i32) {
        self.analyzer_cancelled(compiler);
        self.assert_superseded(id);
    }

    /// An unrelated source notification cannot change an explicit client cancellation.
    pub fn analyzer_cancelled_by_client(&mut self, compiler: sysinfo::Pid, id: i32) {
        self.analyzer_cancelled(compiler);
        self.assert_cancelled(id);
    }

    /// The native marker must arrive without any foreground request rescuing the compiler.
    fn analyzer_cancelled(&mut self, compiler: sysinfo::Pid) {
        assert_eq!(
            self.wait_signal("cancelled", None),
            compiler.as_u32(),
            "IPC cancellation must reach the actual analyzer token"
        );
    }

    /// One genuine editor open invalidates the initial Salsa memo before the held pull.
    fn arm_and_open(&mut self) {
        std::fs::write(self.fixture.signal("arm"), "armed").expect("arm actual project analyzer");
        self.open(2, self.fixture.saved());
    }

    /// Exercise the actual editor overlay for the selected language.
    pub fn open(&mut self, version: i32, source: &str) {
        self.open_document(self.fixture.uri(), version, source);
    }

    /// Exercise another real compiled resource while the primary analyzer remains active.
    pub fn open_other(&mut self, version: i32) {
        self.open_document(
            self.fixture.other_uri(),
            version,
            self.fixture.other_saved(),
        );
    }

    /// One canonical notification encodes both actual editor resources.
    fn open_document(&mut self, uri: String, version: i32, source: &str) {
        let language = if self.fixture.fsharp {
            "fsharp"
        } else {
            "csharp"
        };
        self.client.notify(
            "textDocument/didOpen",
            json!({"textDocument":{
            "uri":uri,"languageId":language,"version":version,"text":source}}),
        );
    }

    /// Register an actual diagnostic request without waiting for the intentionally held reply.
    pub fn begin_pull(&mut self) -> i32 {
        self.begin_request("textDocument/diagnostic")
    }

    /// Workspace analysis uses the actual protocol schema and default solution-wide scope.
    pub fn begin_workspace(&mut self) -> i32 {
        self.begin_params("workspace/diagnostic", json!({"previousResultIds":[]}))
    }

    /// Use the same real LSP framing for diagnostics and compiler-backed editor requests.
    pub fn begin_request(&mut self, method: &str) -> i32 {
        self.begin_params(method, json!({"textDocument":{"uri":self.fixture.uri()}}))
    }

    /// Preserve canonical framing when a client supplies its last real compiler identity.
    fn begin_params(&mut self, method: &str, params: Value) -> i32 {
        let id = next_id();
        self.client
            .send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        self.requests.push(id);
        id
    }

    /// The fresh pull supplies an actual previous result from the independent compiler oracle.
    pub fn begin_fresh_pull(&mut self, previous: &str) -> i32 {
        self.begin_diagnostic(self.fixture.uri(), previous)
    }

    /// Scope isolation uses a second SDK-compiled file, never a fabricated resource.
    pub fn begin_other_pull(&mut self, previous: &str) -> i32 {
        self.begin_diagnostic(self.fixture.other_uri(), previous)
    }

    /// Both resource identities use the same actual previous result and standard framing.
    fn begin_diagnostic(&mut self, uri: String, previous: &str) -> i32 {
        self.begin_params(
            "textDocument/diagnostic",
            json!({"textDocument":{"uri":uri},"previousResultId":previous}),
        )
    }

    /// Foreground acknowledgement observes already queued terminal replies without cancelling.
    pub fn assert_pending(&mut self, id: i32) {
        self.pump();
        assert!(
            self.traffic
                .iter()
                .all(|message| message["id"] != id || message.get("method").is_some()),
            "unrelated or repeated interest must preserve the older request"
        );
    }

    /// Server supersession is an explicit retriable error, never a successful empty report.
    pub fn assert_superseded(&mut self, id: i32) {
        workspace_diagnostic_support::assert_superseded(&self.response(id));
    }

    /// Observe the already requested report, including replies received before the old terminal.
    pub fn current_pull(&mut self, id: i32, previous: &str) -> String {
        let report = self.response(id);
        if report.get("error").is_some() {
            workspace_diagnostic_support::assert_superseded(&report);
            return self.pull(Some("FS0039"), Some(previous));
        }
        assertions::report(&report, Some("FS0039"), Some(previous), self.fixture.tag())
    }

    /// Cancellation preserves actual compiler reference counts after later edits.
    pub fn assert_references(&mut self, previous: &str) {
        let _current = self.change(
            4,
            "module CancellationInput.Library\n\nlet value = 42\nlet other = value + value\n",
            None,
            previous,
        );
        let report = completed_pull(
            &mut self.client,
            "textDocument/codeLens",
            json!({"textDocument":{"uri":self.fixture.uri()}}),
            &mut self.traffic,
        );
        assert_rpc_ok(&report, "current reference counts");
        assert!(report["result"]
            .as_array()
            .expect("reference lenses")
            .iter()
            .any(|lens| lens["range"]["start"]["line"] == 2
                && lens["command"]["title"] == "2 references"));
    }

    /// Explicit client cancellation is processed while the real old source remains held.
    pub fn cancel_pending(&mut self, id: i32) {
        self.request_cancel(id);
        self.assert_cancelled(id);
    }

    /// Preserve client frame order while deliberately awaiting neither competing terminal.
    pub fn request_cancel(&mut self, id: i32) {
        self.client.notify("$/cancelRequest", json!({"id":id}));
    }

    /// The old request gets cancellation, never successful absence or a second terminal reply.
    fn assert_cancelled(&mut self, id: i32) {
        let response = self.response(id);
        assert_eq!(response["error"]["code"], -32800);
        assert!(response.get("result").is_none());
    }

    /// Correlate real terminal traffic through the same existing observer used by cancellation.
    fn response(&mut self, id: i32) -> Value {
        workspace_diagnostic_interruption::cancellation_response(
            &mut self.client,
            id,
            &mut self.traffic,
        )
    }

    /// Pump real server requests while waiting for the analyzer's atomic native signal.
    fn wait_signal(&mut self, suffix: &str, progress: Option<fn(&mut Self)>) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !self.fixture.signal(suffix).exists() {
            assert!(
                Instant::now() < deadline,
                "real analyzer did not signal {suffix}"
            );
            if let Some(progress) = progress {
                progress(self);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.read_signal(suffix)
    }

    /// Configuration is unrelated to compiler work and keeps standard client requests answered.
    fn pump(&mut self) {
        let _ = observed_request(
            &mut self.client,
            "sharplsp/configuration",
            json!({}),
            &mut self.traffic,
        );
    }

    /// The fixture writes this PID only from the real Roslyn semantic-model callback.
    fn read_signal(&self, suffix: &str) -> u32 {
        std::fs::read_to_string(self.fixture.signal(suffix))
            .expect("read actual analyzer identity")
            .parse()
            .expect("actual compiler process ID")
    }

    /// Unsaved source changes must produce a new coherent identity and exact findings.
    pub fn change(
        &mut self,
        version: i32,
        source: &str,
        expected: Option<&str>,
        previous: &str,
    ) -> String {
        self.notify_change(version, source);
        self.pull(expected, Some(previous))
    }

    /// A real editor notification can precede every subsequent diagnostic request.
    pub fn notify_change(&mut self, version: i32, source: &str) {
        self.client
            .change_document(&self.fixture.uri(), version, source);
    }

    /// Close the actual overlay independently of pulling saved compiler truth.
    pub fn notify_close(&mut self) {
        self.client.close_document(&self.fixture.uri());
    }

    /// Closing the unsaved repair restores the independent SDK-proven saved error.
    pub fn close(&mut self, previous: &str, code: &str) {
        self.notify_close();
        let _ = self.pull(Some(code), Some(previous));
        assert_eq!(
            std::fs::read_to_string(&self.fixture.source).expect("saved source"),
            self.fixture.saved()
        );
    }

    /// The real host and compiler acknowledge shutdown and produce only one cancelled reply.
    pub fn finish(self, cancelled: i32) {
        assert!(self.requests.contains(&cancelled));
        self.shut_down();
    }

    /// Shutdown leaves every queued request exactly one terminal reply, and nothing pushed.
    pub fn shut_down(mut self) {
        self.observe_shutdown();
        assert_no_push(&self.traffic);
        for id in &self.requests {
            assert_eq!(
                self.traffic
                    .iter()
                    .filter(|item| item["id"] == *id && item.get("method").is_none())
                    .count(),
                1,
                "each queued request has exactly one terminal response"
            );
        }
    }

    /// Observe through stdout EOF so a late duplicate cannot evade the terminal assertions.
    fn observe_shutdown(&mut self) {
        let reply = observed_request(&mut self.client, "shutdown", Value::Null, &mut self.traffic);
        assert_rpc_ok(&reply, "shutdown actual compiler session");
        assert_eq!(reply["result"], Value::Null);
        self.client.notify("exit", Value::Null);
        self.client.wait_with_timeout();
        while !self
            .client
            .reader
            .fill_buf()
            .expect("terminal traffic")
            .is_empty()
        {
            self.traffic.push(self.client.recv());
        }
    }

    /// The warm-up session exits before a native source barrier is installed.
    pub fn stop(mut self) {
        self.client.shutdown_and_exit();
    }
}
