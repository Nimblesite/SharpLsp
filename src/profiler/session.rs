//! Profiler session management — tracks active trace and counter sessions.

use std::process::Child;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

use anyhow::{bail, Result};
use dashmap::DashMap;
use serde::Serialize;
use tracing::{info, warn};

/// Global session store shared across all profiler handlers.
static SESSIONS: std::sync::OnceLock<SessionStore> = std::sync::OnceLock::new();

/// Maximum concurrent profiling sessions.
static MAX_SESSIONS: AtomicU32 = AtomicU32::new(5);

/// Set the maximum concurrent sessions from config.
pub fn set_max_sessions(max: u32) {
    MAX_SESSIONS.store(max, Ordering::Relaxed);
}

/// Get the global session store.
pub fn store() -> &'static SessionStore {
    SESSIONS.get_or_init(SessionStore::new)
}

/// The type of profiling session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    /// A `dotnet-trace` collection session.
    Trace,
    /// A `dotnet-counters` monitoring session.
    Counters,
}

/// State of a profiling session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    /// Session is actively collecting data.
    Running,
    /// Session was stopped normally.
    Stopped,
    /// Session terminated due to an error.
    Failed,
}

/// An active profiling session.
pub struct ProfileSession {
    /// Unique session identifier.
    pub id: String,
    /// Kind of profiling session.
    #[expect(dead_code, reason = "read by session listing and future UI")]
    pub kind: SessionKind,
    /// Target process ID.
    #[expect(dead_code, reason = "read by session listing and future UI")]
    pub pid: u32,
    /// Current session state.
    pub state: SessionState,
    /// Path to the output artifact, if available.
    pub output_path: Option<String>,
    /// When the session was created.
    pub started_at: Instant,
    /// Handle to the spawned tool process.
    pub child: Option<Child>,
}

/// Thread-safe store for active profiling sessions.
pub struct SessionStore {
    /// Map of session ID to active session.
    sessions: DashMap<String, ProfileSession>,
}

impl SessionStore {
    /// Create an empty session store.
    #[cfg(not(test))]
    fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    /// Create a new session, enforcing the max concurrent limit.
    pub fn create(
        &self,
        kind: SessionKind,
        pid: u32,
        output_path: Option<String>,
        child: Child,
    ) -> Result<String> {
        let max = MAX_SESSIONS.load(Ordering::Relaxed);
        self.create_with_limit(kind, pid, output_path, child, max)
    }

    /// Create a new session with an explicit max-session limit.
    fn create_with_limit(
        &self,
        kind: SessionKind,
        pid: u32,
        output_path: Option<String>,
        child: Child,
        max: u32,
    ) -> Result<String> {
        let active = self.active_count();
        if active >= max {
            bail!("session limit reached ({active}/{max}). Stop an existing session first");
        }

        let id = generate_session_id();
        info!(session_id = %id, kind = ?kind, pid = pid, "Profiler session created");

        let _ = self.sessions.insert(
            id.clone(),
            ProfileSession {
                id: id.clone(),
                kind,
                pid,
                state: SessionState::Running,
                output_path,
                started_at: Instant::now(),
                child: Some(child),
            },
        );

        Ok(id)
    }

    /// Take the child process out of a session (for stopping).
    pub fn take_child(&self, session_id: &str) -> Result<Child> {
        let mut entry = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow::anyhow!("session not found: {session_id}"))?;

        entry
            .child
            .take()
            .ok_or_else(|| anyhow::anyhow!("session already stopped: {session_id}"))
    }

    /// Mark a session as stopped and record its output path.
    pub fn mark_stopped(&self, session_id: &str, output_path: Option<String>) {
        if let Some(mut entry) = self.sessions.get_mut(session_id) {
            entry.state = SessionState::Stopped;
            if let Some(path) = output_path {
                entry.output_path = Some(path);
            }
            info!(session_id = %session_id, "Profiler session stopped");
        }
    }

    /// Mark a session as failed.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "used by error handling in trace/counter sessions")
    )]
    pub fn mark_failed(&self, session_id: &str) {
        if let Some(mut entry) = self.sessions.get_mut(session_id) {
            entry.state = SessionState::Failed;
            warn!(session_id = %session_id, "Profiler session failed");
        }
    }

    /// Remove a stopped/failed session.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "used by session cleanup after results are consumed"
        )
    )]
    pub fn remove(&self, session_id: &str) {
        let _ = self.sessions.remove(session_id);
    }

    /// Access the underlying session map (for reading session metadata).
    pub fn sessions(&self) -> &DashMap<String, ProfileSession> {
        &self.sessions
    }

    /// Count sessions in the Running state.
    fn active_count(&self) -> u32 {
        let count: usize = self
            .sessions
            .iter()
            .filter(|entry| entry.state == SessionState::Running)
            .count();
        u32::try_from(count).unwrap_or(u32::MAX)
    }

    /// Clean up all sessions (called on LSP shutdown).
    pub fn shutdown(&self) {
        info!("Cleaning up profiler sessions");
        let session_ids: Vec<String> = self.sessions.iter().map(|entry| entry.id.clone()).collect();

        for id in session_ids {
            if let Some(mut entry) = self.sessions.get_mut(&id) {
                if let Some(ref mut child) = entry.child {
                    let _ = child.kill();
                }
                entry.state = SessionState::Stopped;
            }
        }
        self.sessions.clear();
        info!("All profiler sessions cleaned up");
    }
}

/// Generate a short unique session ID.
fn generate_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    format!("prof-{ts}-{seq}")
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;
    use crate::profiler::test_support::{spawn_long_lived, spawn_quick_success};

    /// Spawn a trivial child process for testing.
    fn dummy_child() -> Child {
        spawn_quick_success()
    }

    #[test]
    fn create_and_take_child() {
        let store = SessionStore::new();
        let id = store
            .create_with_limit(SessionKind::Trace, 1234, None, dummy_child(), 100)
            .unwrap();

        assert!(store.sessions().contains_key(&id));

        let mut child = store.take_child(&id).unwrap();
        let _ = child.wait();

        // Second take should fail — child already taken.
        let err = store.take_child(&id).unwrap_err();
        assert!(
            err.to_string().contains("already stopped"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn mark_stopped_without_output_path() {
        let store = SessionStore::new();
        let id = store
            .create_with_limit(SessionKind::Counters, 42, None, dummy_child(), 100)
            .unwrap();

        store.mark_stopped(&id, None);

        let entry = store.sessions().get(&id).unwrap();
        assert_eq!(entry.state, SessionState::Stopped);
        assert!(entry.output_path.is_none());
    }

    #[test]
    fn mark_stopped_with_output_path() {
        let store = SessionStore::new();
        let id = store
            .create_with_limit(SessionKind::Trace, 99, None, dummy_child(), 100)
            .unwrap();

        store.mark_stopped(&id, Some("/tmp/trace.nettrace".to_string()));

        let entry = store.sessions().get(&id).unwrap();
        assert_eq!(entry.state, SessionState::Stopped);
        assert_eq!(entry.output_path.as_deref(), Some("/tmp/trace.nettrace"));
    }

    #[test]
    fn mark_stopped_overwrites_existing_output_path() {
        let store = SessionStore::new();
        let id = store
            .create_with_limit(
                SessionKind::Trace,
                10,
                Some("/old/path".to_string()),
                dummy_child(),
                100,
            )
            .unwrap();

        store.mark_stopped(&id, Some("/new/path".to_string()));

        let entry = store.sessions().get(&id).unwrap();
        assert_eq!(entry.output_path.as_deref(), Some("/new/path"));
    }

    #[test]
    fn mark_failed_sets_state() {
        let store = SessionStore::new();
        let id = store
            .create_with_limit(SessionKind::Counters, 55, None, dummy_child(), 100)
            .unwrap();

        store.mark_failed(&id);

        let entry = store.sessions().get(&id).unwrap();
        assert_eq!(entry.state, SessionState::Failed);
    }

    #[test]
    fn mark_failed_nonexistent_session_is_noop() {
        let store = SessionStore::new();
        // Should not panic.
        store.mark_failed("nonexistent-id");
    }

    #[test]
    fn remove_deletes_session() {
        let store = SessionStore::new();
        let id = store
            .create_with_limit(SessionKind::Trace, 77, None, dummy_child(), 100)
            .unwrap();

        assert!(store.sessions().contains_key(&id));
        store.remove(&id);
        assert!(!store.sessions().contains_key(&id));
    }

    #[test]
    fn remove_nonexistent_session_is_noop() {
        let store = SessionStore::new();
        // Should not panic.
        store.remove("does-not-exist");
    }

    #[test]
    fn session_limit_enforced() {
        let store = SessionStore::new();

        let _id1 = store
            .create_with_limit(SessionKind::Trace, 1, None, dummy_child(), 2)
            .unwrap();
        let _id2 = store
            .create_with_limit(SessionKind::Counters, 2, None, dummy_child(), 2)
            .unwrap();

        let err = store
            .create_with_limit(SessionKind::Trace, 3, None, dummy_child(), 2)
            .unwrap_err();
        assert!(
            err.to_string().contains("session limit reached"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn shutdown_kills_children_and_clears() {
        let store = SessionStore::new();
        // Spawn a longer-lived process so we can verify kill.
        let child = spawn_long_lived();
        let pid = child.id();

        let id = store
            .create_with_limit(SessionKind::Trace, pid, None, child, 100)
            .unwrap();

        assert!(store.sessions().contains_key(&id));
        store.shutdown();
        assert!(store.sessions().is_empty());
    }

    #[test]
    fn take_child_nonexistent_session_errors() {
        let store = SessionStore::new();
        let err = store.take_child("no-such-session").unwrap_err();
        assert!(
            err.to_string().contains("session not found"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn stopped_sessions_not_counted_as_active() {
        let store = SessionStore::new();

        let id1 = store
            .create_with_limit(SessionKind::Trace, 1, None, dummy_child(), 2)
            .unwrap();
        let _id2 = store
            .create_with_limit(SessionKind::Trace, 2, None, dummy_child(), 2)
            .unwrap();

        // At limit — next create should fail.
        assert!(store
            .create_with_limit(SessionKind::Trace, 3, None, dummy_child(), 2)
            .is_err());

        // Mark stopped — active count drops.
        store.mark_stopped(&id1, None);

        // Now we should be able to create another.
        let _id3 = store
            .create_with_limit(SessionKind::Trace, 4, None, dummy_child(), 2)
            .unwrap();
    }
}
