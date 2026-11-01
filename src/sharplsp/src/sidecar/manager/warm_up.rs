//! After a workspace opens, the F# compiler warms every project's check as
//! background work, so the user's first solution-wide query (references,
//! rename, lens counts) answers warm instead of paying a full check (#513).
//! One request warms one project, so diagnostics interleave between them. An
//! interactive request preempts the request in flight like any background
//! work; the walk retries that project after a pause, from the checks the
//! compiler already holds. A newer open abandons the walk for its own.
//! Implements [SHARPLSP-FEATURES-WARM-UP].
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use lspkit::sidecar::cancellation::RequestCancelled;
use tokio::sync::watch;
use tracing::{info, warn};

use super::SidecarManager;
use crate::tree_sitter_parse::LangId;

/// The compiler request that warms one project's check.
pub(crate) const WARM_UP: &str = "workspace/warm";

/// The first pause after a preemption; each further one doubles it.
const FIRST_PAUSE: Duration = Duration::from_millis(500);

/// The longest pause between preempted attempts.
const LONGEST_PAUSE: Duration = Duration::from_secs(8);

/// The workspace opens the warm-up serves, and whether its task runs.
pub(super) struct WarmUp {
    /// Bumped by every successful `workspace/open`.
    opened: watch::Sender<u64>,
    /// Set once the warm-up task runs, so each manager runs one.
    running: AtomicBool,
}

impl Default for WarmUp {
    fn default() -> Self {
        Self {
            opened: watch::channel(0).0,
            running: AtomicBool::new(false),
        }
    }
}

impl SidecarManager {
    /// Record a completed `workspace/open`: the warm-up walks the new workspace.
    pub(crate) fn workspace_opened(&self) {
        self.warm_up
            .opened
            .send_modify(|generation| *generation += 1);
    }

    /// Warm each opened workspace's projects in the background, once per
    /// manager and only for the F# compiler; any other call returns at once.
    pub async fn start_warm_up(self: Arc<Self>) {
        if self.language != Some(LangId::FSharp)
            || self.warm_up.running.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let mut opened = self.warm_up.opened.subscribe();
        loop {
            let generation = *opened.borrow_and_update();
            if generation > 0 {
                self.warm(&opened, generation).await;
            }
            if opened.changed().await.is_err() {
                return;
            }
        }
    }

    /// Warm `generation`'s projects one request at a time, until every one is
    /// warm, a newer open supersedes it, or the compiler fails otherwise.
    async fn warm(&self, opened: &watch::Receiver<u64>, generation: u64) {
        let mut index = 0_usize;
        let mut pause = FIRST_PAUSE;
        while *opened.borrow() == generation && !self.is_shutting_down() {
            match self.warm_one(index).await {
                Ok(total) if index + 1 >= total => {
                    info!(sidecar = %self.name, projects = total, "Compiler workspace warm");
                    return;
                }
                Ok(_) => (index, pause) = (index + 1, FIRST_PAUSE),
                Err(error) if error.is::<RequestCancelled>() => {
                    tokio::time::sleep(pause).await;
                    pause = (pause * 2).min(LONGEST_PAUSE);
                }
                Err(error) => {
                    warn!(sidecar = %self.name, error = %format!("{error:#}"), "Compiler warm-up stopped");
                    return;
                }
            }
        }
    }

    /// Warm the `index`-th project; the compiler answers with how many it holds.
    async fn warm_one(&self, index: usize) -> Result<usize> {
        let answer = self
            .request_cancellable(WARM_UP, rmp_serde::to_vec(&index)?, None)
            .await?;
        Ok(rmp_serde::from_slice(&answer)?)
    }
}
