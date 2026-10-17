//! An in-memory Zed host for resolution tests: its file system, PATH and GitHub
//! are fields, and every call is recorded.
use std::cell::RefCell;
use std::collections::BTreeSet;

use zed_extension_api as zed;

use crate::archive::Target;
use crate::server::{Configured, Host, Release, Status, REPOSITORY};

/// A Zed host whose file system, PATH and GitHub are in-memory, recording every call.
pub(crate) struct Fake {
    pub(crate) configured: Configured,
    pub(crate) which: Option<String>,
    pub(crate) platform: (zed::Os, zed::Architecture),
    pub(crate) release: Result<Release, String>,
    pub(crate) files: RefCell<BTreeSet<String>>,
    pub(crate) entries: RefCell<Vec<String>>,
    pub(crate) calls: RefCell<Vec<String>>,
}

impl Fake {
    pub(crate) fn new() -> Self {
        Self {
            configured: Configured::default(),
            which: None,
            platform: (zed::Os::Mac, zed::Architecture::Aarch64),
            release: Ok(release("v0.26.0")),
            files: RefCell::default(),
            entries: RefCell::default(),
            calls: RefCell::default(),
        }
    }

    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }

    fn record(&self, call: String) {
        self.calls.borrow_mut().push(call);
    }
}

/// A release carrying every [DIST-ARCHIVE] asset, as v0.26.0 does.
pub(crate) fn release(version: &str) -> Release {
    let assets = [
        "darwin-arm64.tar.gz",
        "linux-x64.tar.gz",
        "linux-arm64.tar.gz",
    ]
    .into_iter()
    .chain(["win32-x64.zip", "win32-arm64.zip"])
    .map(|suffix| {
        let name = format!("sharplsp-{suffix}");
        let url = format!("https://github.com/{REPOSITORY}/releases/download/{version}/{name}");
        (name, url)
    })
    .collect();
    Release {
        version: version.to_owned(),
        assets,
    }
}

impl Host for Fake {
    fn configured(&self) -> Configured {
        self.configured.clone()
    }
    fn which(&self) -> Option<String> {
        self.record("which".to_owned());
        self.which.clone()
    }
    fn platform(&self) -> (zed::Os, zed::Architecture) {
        self.platform
    }
    fn is_file(&self, path: &str) -> bool {
        self.files.borrow().contains(path)
    }
    fn latest_release(&self) -> Result<Release, String> {
        self.record("latest_release".to_owned());
        self.release.clone()
    }
    fn report(&self, status: Status) {
        self.record(format!("{status:?}"));
    }
    /// Unpacks the archive the way Zed does: the platform directory with all three executables.
    fn download(&self, url: &str, dir: &str, zip: bool) -> Result<(), String> {
        self.record(format!("download {url} -> {dir} zip={zip}"));
        let (os, arch) = self.platform;
        let target = Target::for_platform(os, arch).ok_or("no target")?;
        self.files.borrow_mut().extend(target.executables(dir));
        self.entries.borrow_mut().push(dir.to_owned());
        Ok(())
    }
    fn make_executable(&self, path: &str) -> Result<(), String> {
        self.record(format!("chmod {path}"));
        Ok(())
    }
    fn entries(&self) -> Vec<String> {
        self.entries.borrow().clone()
    }
    fn remove(&self, dir: &str) -> Result<(), String> {
        self.record(format!("remove {dir}"));
        self.entries.borrow_mut().retain(|entry| entry != dir);
        Err("in use".to_owned())
    }
}
