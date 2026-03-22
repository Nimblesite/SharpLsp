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
    Trace,
    Counters,
}

/// State of a profiling session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Running,
    Stopped,
    Failed,
}

/// An active profiling session.
pub struct ProfileSession {
    pub id: String,
    #[expect(dead_code, reason = "read by session listing and future UI")]
    pub kind: SessionKind,
    #[expect(dead_code, reason = "read by session listing and future UI")]
    pub pid: u32,
    pub state: SessionState,
    pub output_path: Option<String>,
    pub started_at: Instant,
    pub child: Option<Child>,
}

/// Thread-safe store for active profiling sessions.
pub struct SessionStore {
    sessions: DashMap<String, ProfileSession>,
}

impl SessionStore {
    fn new() -> Self {
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
        let active = self.active_count();
        let max = MAX_SESSIONS.load(Ordering::Relaxed);
        if active >= max {
            bail!("session limit reached ({active}/{max}). Stop an existing session first");
        }

        let id = generate_session_id();
        info!(session_id = %id, kind = ?kind, pid = pid, "Profiler session created");

        self.sessions.insert(
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
    #[expect(dead_code, reason = "used by error handling in trace/counter sessions")]
    pub fn mark_failed(&self, session_id: &str) {
        if let Some(mut entry) = self.sessions.get_mut(session_id) {
            entry.state = SessionState::Failed;
            warn!(session_id = %session_id, "Profiler session failed");
        }
    }

    /// Remove a stopped/failed session.
    #[expect(
        dead_code,
        reason = "used by session cleanup after results are consumed"
    )]
    pub fn remove(&self, session_id: &str) {
        self.sessions.remove(session_id);
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
