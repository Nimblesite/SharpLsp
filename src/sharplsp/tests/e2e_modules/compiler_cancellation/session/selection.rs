//! Real solution selection uses canonical framing and retirement assertions. [DIAG-TRUTH-GUARANTEES]
use super::*;

impl Session<'_> {
    /// Acknowledging scheduling does not establish that compiler inputs are ready.
    pub fn select(&mut self, selected: &Fixture) {
        let response = observed_request(
            &mut self.client,
            "sharplsp/loadSolution",
            json!({"solutionPath":selected.solution}),
            &mut self.traffic,
        );
        assert_rpc_ok(&response, "select actual SDK solution");
        assert_eq!(response["result"]["success"], true);
    }

    /// Return to the original real selector without replacing the host or compiler.
    pub fn select_original(&mut self) {
        self.load();
    }

    /// A different selected file must return the first successful exact compiler truth.
    pub fn selected_pull(&mut self, selected: &Fixture, code: &str, previous: &str) -> String {
        self.pull_uri(selected.uri(), Some(code), Some(previous))
    }

    /// The new scope retires the original source through a real workspace report.
    pub fn selected_scope(&mut self, selected: &Fixture, code: &str, previous: &str) -> String {
        self.scope(selected.uri(), self.fixture.uri(), code, previous)
    }

    /// Switching back also retires the second solution's previous source report.
    pub fn original_scope(&mut self, retired: &Fixture, code: &str, previous: &str) -> String {
        self.scope(self.fixture.uri(), retired.uri(), code, previous)
    }

    /// Only explicit supersession may be retried; the first successful scope must be correct.
    fn scope(&mut self, selected: String, retired: String, code: &str, previous: &str) -> String {
        let old = [json!({"uri":retired,"value":previous})];
        let report = completed_pull(
            &mut self.client,
            "workspace/diagnostic",
            json!({"previousResultIds":old}),
            &mut self.traffic,
        );
        assert_no_push(&self.traffic);
        assertions::selected_scope(&report, &selected, &old, code)
    }
}
