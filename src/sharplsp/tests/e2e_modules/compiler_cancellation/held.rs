//! The actual compiler read is the barrier. [DIAG-ANALYSIS-CANCELLATION]
use super::*;
use std::io;
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc};

/// Opening the real file is permanent evidence; the active hold can later end.
type Flags = (Arc<AtomicBool>, Arc<AtomicBool>);

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
use unix as native;
#[cfg(windows)]
use windows as native;

/// Own the native resource and release it automatically if a broken server waits for it.
pub struct Barrier {
    release: Option<mpsc::Sender<()>>,
    ready: mpsc::Receiver<()>,
    opened: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<io::Result<()>>>,
    source: PathBuf,
}

impl Barrier {
    /// Install before the second host starts so its watcher cannot mistake setup for an edit.
    pub fn new(fixture: &fixture::Fixture) -> Self {
        let source = native::Source::new(&fixture.source, fixture.saved()).expect("native barrier");
        let (release, receive) = mpsc::channel();
        let (signal, ready) = mpsc::channel();
        let opened = Arc::new(AtomicBool::new(false));
        let active = Arc::new(AtomicBool::new(false));
        let (seen, held) = (Arc::clone(&opened), Arc::clone(&active));
        let worker = Self::spawn(source, signal, receive, (seen, held));
        Self {
            release: Some(release),
            ready,
            opened,
            active,
            worker: Some(worker),
            source: fixture.source.clone(),
        }
    }

    /// Hold real native I/O until explicit release or the failing-test guard.
    fn spawn(
        source: native::Source,
        signal: mpsc::Sender<()>,
        receive: mpsc::Receiver<()>,
        (seen, held): Flags,
    ) -> std::thread::JoinHandle<io::Result<()>> {
        std::thread::spawn(move || {
            let reader = source.opened()?;
            seen.store(true, Ordering::SeqCst);
            held.store(true, Ordering::SeqCst);
            signal.send(()).map_err(io::Error::other)?;
            let _ = receive.recv_timeout(Duration::from_secs(20));
            held.store(false, Ordering::SeqCst);
            reader.release()
        })
    }

    /// Actual kernel readiness precedes cancellation; Linux also verifies the FCS-owned FD.
    pub fn wait(&self, compiler: sysinfo::Pid) {
        self.ready
            .recv_timeout(Duration::from_secs(20))
            .expect("actual compiler opened native source");
        assert!(self.is_held());
        self.assert_holder(compiler);
    }

    /// A successful current pull must finish before the old native read is released.
    pub fn is_held(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    #[cfg(target_os = "linux")]
    fn assert_holder(&self, compiler: sysinfo::Pid) {
        let expected = canonical_file_uri(&self.source).expect("held source identity");
        let descriptors =
            std::fs::read_dir(format!("/proc/{compiler}/fd")).expect("actual compiler descriptors");
        assert!(
            descriptors
                .filter_map(Result::ok)
                .filter_map(|entry| std::fs::read_link(entry.path()).ok())
                .filter_map(|path| canonical_file_uri(&path).ok())
                .any(|uri| uri == expected),
            "the held read belongs to the actual F# compiler"
        );
    }

    #[cfg(not(target_os = "linux"))]
    fn assert_holder(&self, _compiler: sysinfo::Pid) {
        assert!(self.is_held());
    }

    /// Finish and observe the native owner; no live editor or global cache is touched.
    pub fn release(mut self) {
        self.finish(true);
    }

    fn finish(&mut self, verify: bool) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        if let Some(worker) = self
            .worker
            .take()
            .filter(|_| self.opened.load(Ordering::SeqCst))
        {
            let result = worker.join();
            if verify {
                result
                    .expect("native source owner exits")
                    .expect("native source released");
            }
        }
    }
}

impl Drop for Barrier {
    fn drop(&mut self) {
        self.finish(false);
    }
}
