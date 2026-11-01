//! Scoped stop/continue for an owned native child, never an editor. [LSP-PULL-WATCH]
use std::io;
use std::process::Command;

use tokio::time::timeout;

/// Resuming is mandatory even if the fixture's burst fails.
pub struct Stopped(Option<u32>);

/// Confirm the kernel stop state before creating a native queue overflow.
pub async fn suspend(pid: u32, guard: std::time::Duration) -> Stopped {
    let stopped = Stopped(Some(pid));
    signal(pid, "-STOP").expect("stop only the owned native reference");
    timeout(guard, async {
        while !is_stopped(pid).await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("native reference reaches the kernel stop state");
    stopped
}

async fn is_stopped(pid: u32) -> bool {
    let output = tokio::process::Command::new("ps")
        .args(["-o", "state=", "-p", &pid.to_string()])
        .output()
        .await
        .expect("read only the owned process state");
    assert!(output.status.success(), "owned reference remains available");
    String::from_utf8(output.stdout)
        .expect("native process state is UTF-8")
        .trim()
        == "T"
}

fn signal(pid: u32, signal: &str) -> io::Result<()> {
    let status = Command::new("kill")
        .args([signal, &pid.to_string()])
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("owned native reference signal failed"))
    }
}

impl Stopped {
    /// Restore execution before consuming real native batches.
    pub fn resume(mut self) {
        let pid = self.0.expect("one owned native reference");
        signal(pid, "-CONT").expect("resume the owned native reference");
        self.0 = None;
    }
}

impl Drop for Stopped {
    fn drop(&mut self) {
        if let Some(pid) = self.0.take() {
            if let Err(error) = signal(pid, "-CONT") {
                tracing::error!(%error, "Owned native reference resume failed");
            }
        }
    }
}
