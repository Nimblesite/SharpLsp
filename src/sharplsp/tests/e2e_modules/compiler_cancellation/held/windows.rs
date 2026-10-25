//! NTFS holds the real source open through the shared oplock fixture. [DIAG-ANALYSIS-CANCELLATION]
use super::*;
use std::io::BufReader;
use std::process::ChildStdout;

#[path = "../../../../../../lspkit/test-support/windows-oplock/owner.rs"]
mod owner;

pub struct Source {
    child: Child,
    output: BufReader<ChildStdout>,
}
pub type Reader = Source;

impl Source {
    pub fn new(path: &Path, _original: &str) -> io::Result<Self> {
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../lspkit/test-support/windows-oplock/hold.ps1");
        let mut child = owner::spawn(&script, path);
        let output = BufReader::new(child.stdout.take().expect("native owner stdout"));
        let mut source = Self { child, output };
        owner::state(&mut source.output, "ready")?;
        Ok(source)
    }

    pub fn opened(mut self) -> io::Result<Reader> {
        owner::state(&mut self.output, "blocked")?;
        Ok(self)
    }

    pub fn release(mut self) -> io::Result<()> {
        drop(self.child.stdin.take());
        owner::state(&mut self.output, "released")?;
        if !self.child.wait()?.success() {
            return Err(io::Error::other("native source owner failed"));
        }
        Ok(())
    }
}

/// Readiness failures and abandoned checks still reap only their owned native fixture.
impl Drop for Source {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return;
        }
        if let Err(error) = self.child.kill() {
            tracing::warn!(%error, "Native source owner termination failed");
        }
        if let Err(error) = self.child.wait() {
            tracing::warn!(%error, "Native source owner wait failed");
        }
    }
}
