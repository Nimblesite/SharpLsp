//! Locate the SharpLsp server, downloading the release archive when no install is
//! found. Implements [DIST-ZED-REGISTRY]: the registry forbids bundling a language
//! server, so the extension detects one or fetches the [DIST-ARCHIVE] asset.
use zed_extension_api as zed;

use crate::archive::Target;

/// The GitHub repository whose releases carry the standalone server archives.
pub(crate) const REPOSITORY: &str = "Nimblesite/SharpLsp";
/// The language server key in `extension.toml` and in the user's `lsp` settings.
pub(crate) const LANGUAGE_SERVER: &str = "sharplsp";
/// The host executable, on PATH and inside every archive.
pub(crate) const SERVER_BINARY: &str = "sharplsp";
/// Each download lives in `sharplsp-<release tag>` inside the extension's work directory.
const DOWNLOAD_PREFIX: &str = "sharplsp-";

/// A published release: its tag and every asset's name and download URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Release {
    pub(crate) version: String,
    pub(crate) assets: Vec<(String, String)>,
}

/// `lsp.sharplsp.binary` from the user's Zed settings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Configured {
    pub(crate) path: Option<String>,
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
}

/// The command Zed spawns, with the environment the user configured for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Launch {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
}

/// Installation progress Zed shows beside the language server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    Checking,
    Downloading,
    Ready,
}

/// Everything resolution needs from Zed. `zed_host` implements it over the WASM
/// host; the tests fake it, because that host exists only inside Zed.
pub(crate) trait Host {
    fn configured(&self) -> Configured;
    fn which(&self) -> Option<String>;
    fn platform(&self) -> (zed::Os, zed::Architecture);
    fn is_file(&self, path: &str) -> bool;
    fn latest_release(&self) -> Result<Release, String>;
    fn report(&self, status: Status);
    fn download(&self, url: &str, dir: &str, zip: bool) -> Result<(), String>;
    fn make_executable(&self, path: &str) -> Result<(), String>;
    fn entries(&self) -> Vec<String>;
    fn remove(&self, dir: &str) -> Result<(), String>;
}

/// Resolve the server: the configured path, then PATH, then a download.
/// Configured arguments and environment apply whichever binary is chosen.
pub(crate) fn resolve(host: &impl Host, cache: &mut Option<String>) -> Result<Launch, String> {
    let Configured { path, args, env } = host.configured();
    let command = match path.or_else(|| host.which()) {
        Some(command) => command,
        None => downloaded(host, cache)?,
    };
    Ok(Launch { command, args, env })
}

/// The cached download while it still exists, otherwise the latest release's.
fn downloaded(host: &impl Host, cache: &mut Option<String>) -> Result<String, String> {
    if let Some(path) = cache.as_ref().filter(|path| host.is_file(path)) {
        return Ok(path.clone());
    }
    let (os, arch) = host.platform();
    let target = Target::for_platform(os, arch).ok_or_else(|| unsupported(os, arch))?;
    host.report(Status::Checking);
    let path = match host.latest_release() {
        Ok(release) => install(host, target, &release)?,
        Err(error) => offline(host, target).ok_or(error)?,
    };
    host.report(Status::Ready);
    *cache = Some(path.clone());
    Ok(path)
}

/// Download and unpack `release` unless it is already on disk, then drop older ones.
fn install(host: &impl Host, target: Target, release: &Release) -> Result<String, String> {
    let dir = format!("{DOWNLOAD_PREFIX}{}", release.version);
    let executables = target.executables(&dir);
    if !host.is_file(&executables[0]) {
        let asset = target.asset();
        let url = asset_url(release, &asset)?;
        host.report(Status::Downloading);
        host.download(url, &dir, target.zip())?;
        executables
            .iter()
            .try_for_each(|path| host.make_executable(path))?;
        prune(host, &dir);
    }
    let [server, ..] = executables;
    Ok(server)
}

/// The download URL of `asset`, or why the release cannot serve this platform.
fn asset_url<'a>(release: &'a Release, asset: &str) -> Result<&'a str, String> {
    release
        .assets
        .iter()
        .find(|(name, _)| name == asset)
        .map(|(_, url)| url.as_str())
        .ok_or_else(|| format!("SharpLsp {} has no {asset} asset", release.version))
}

/// With GitHub unreachable, start the newest earlier download rather than nothing.
fn offline(host: &impl Host, target: Target) -> Option<String> {
    let mut downloads: Vec<String> = host
        .entries()
        .into_iter()
        .filter(|entry| entry.starts_with(DOWNLOAD_PREFIX))
        .collect();
    downloads.sort();
    downloads
        .iter()
        .rev()
        .map(|dir| target.executables(dir)[0].clone())
        .find(|server| host.is_file(server))
}

/// Remove superseded downloads. Best effort by design: a server from an older
/// release may still be running in another window, and Windows refuses to delete
/// its files. That must not stop this window's newer server from starting.
fn prune(host: &impl Host, keep: &str) {
    for dir in host.entries() {
        if dir.starts_with(DOWNLOAD_PREFIX) && dir != keep {
            let _ = host.remove(&dir);
        }
    }
}

/// The guidance shown where no release archive exists for this machine.
fn unsupported(os: zed::Os, arch: zed::Architecture) -> String {
    let os = match os {
        zed::Os::Mac => "macOS",
        zed::Os::Linux => "Linux",
        zed::Os::Windows => "Windows",
    };
    let arch = match arch {
        zed::Architecture::Aarch64 => "arm64",
        zed::Architecture::X86 => "x86",
        zed::Architecture::X8664 => "x86-64",
    };
    format!(
        "SharpLsp publishes no server for {os} {arch}. Put `{SERVER_BINARY}` on PATH \
         (see https://github.com/{REPOSITORY}#install) or set lsp.{LANGUAGE_SERVER}.binary.path"
    )
}

/// Resolution contract tests. Implements [DIST-ZED-REGISTRY], [DIST-ARCHIVE].
#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_host::Fake;

    #[test]
    fn a_configured_path_wins_and_its_arguments_are_passed() {
        let mut host = Fake::new();
        host.configured = Configured {
            path: Some("/opt/sharplsp".to_owned()),
            args: vec!["--stdio".to_owned()],
            env: vec![("DOTNET_ROOT".to_owned(), "/opt/dotnet".to_owned())],
        };
        host.which = Some("/usr/local/bin/sharplsp".to_owned());
        let mut cache = None;

        let launch = resolve(&host, &mut cache);

        assert_eq!(
            launch,
            Ok(Launch {
                command: "/opt/sharplsp".to_owned(),
                args: vec!["--stdio".to_owned()],
                env: vec![("DOTNET_ROOT".to_owned(), "/opt/dotnet".to_owned())],
            })
        );
        assert!(
            host.calls().is_empty(),
            "no lookup or download: {:?}",
            host.calls()
        );
        assert_eq!(
            cache, None,
            "a configured path is never cached as a download"
        );
    }

    #[test]
    fn an_install_on_path_is_used_before_any_download() {
        let mut host = Fake::new();
        host.which = Some("/opt/homebrew/bin/sharplsp".to_owned());
        host.configured.args = vec!["--log".to_owned()];
        let mut cache = None;

        let launch = resolve(&host, &mut cache);

        assert_eq!(
            launch.as_ref().map(|launch| launch.command.as_str()),
            Ok("/opt/homebrew/bin/sharplsp")
        );
        assert_eq!(
            launch.map(|launch| launch.args),
            Ok(vec!["--log".to_owned()])
        );
        assert_eq!(host.calls(), ["which"]);
    }

    #[test]
    fn a_missing_server_is_downloaded_made_executable_and_cached() {
        let host = Fake::new();
        host.entries
            .borrow_mut()
            .push("sharplsp-v0.25.0".to_owned());
        let mut cache = None;
        let server = "sharplsp-v0.26.0/sharplsp-darwin-arm64/sharplsp";
        let url = format!(
            "https://github.com/{REPOSITORY}/releases/download/v0.26.0/sharplsp-darwin-arm64.tar.gz"
        );

        let launch = resolve(&host, &mut cache);

        assert_eq!(launch.map(|launch| launch.command).as_deref(), Ok(server));
        assert_eq!(cache.as_deref(), Some(server));
        let calls = host.calls();
        assert_eq!(
            calls[..4],
            ["which", "Checking", "latest_release", "Downloading"]
        );
        assert_eq!(
            calls[4],
            format!("download {url} -> sharplsp-v0.26.0 zip=false")
        );
        let chmod: Vec<&String> = calls
            .iter()
            .filter(|call| call.starts_with("chmod"))
            .collect();
        assert_eq!(
            chmod.len(),
            3,
            "the host and both sidecar apphosts: {calls:?}"
        );
        assert!(
            calls.contains(&"remove sharplsp-v0.25.0".to_owned()),
            "{calls:?}"
        );
        assert!(
            !calls.contains(&"remove sharplsp-v0.26.0".to_owned()),
            "{calls:?}"
        );
        assert_eq!(calls.last().map(String::as_str), Some("Ready"));
    }

    #[test]
    fn the_cached_download_is_reused_until_it_disappears() {
        let host = Fake::new();
        let mut cache = Some("sharplsp-v0.26.0/sharplsp-darwin-arm64/sharplsp".to_owned());
        host.files
            .borrow_mut()
            .insert("sharplsp-v0.26.0/sharplsp-darwin-arm64/sharplsp".to_owned());

        assert!(resolve(&host, &mut cache).is_ok());
        assert_eq!(
            host.calls(),
            ["which"],
            "a live cache skips GitHub entirely"
        );

        host.files.borrow_mut().clear();
        assert!(resolve(&host, &mut cache).is_ok());
        assert!(
            host.calls().iter().any(|call| call.starts_with("download")),
            "{:?}",
            host.calls()
        );
    }

    #[test]
    fn an_already_unpacked_release_is_not_downloaded_again() {
        let host = Fake::new();
        host.files
            .borrow_mut()
            .insert("sharplsp-v0.26.0/sharplsp-darwin-arm64/sharplsp".to_owned());
        let mut cache = None;

        let launch = resolve(&host, &mut cache);

        assert!(launch.is_ok(), "{launch:?}");
        assert_eq!(
            host.calls(),
            ["which", "Checking", "latest_release", "Ready"]
        );
    }

    #[test]
    fn offline_starts_the_newest_earlier_download() {
        let mut host = Fake::new();
        host.release = Err("network unreachable".to_owned());
        host.entries
            .borrow_mut()
            .extend(["sharplsp-v0.24.0", "sharplsp-v0.25.0", "other"].map(str::to_owned));
        host.files.borrow_mut().extend(
            ["v0.24.0", "v0.25.0"]
                .map(|tag| format!("sharplsp-{tag}/sharplsp-darwin-arm64/sharplsp")),
        );
        let mut cache = None;

        let launch = resolve(&host, &mut cache);

        assert_eq!(
            launch.map(|launch| launch.command).as_deref(),
            Ok("sharplsp-v0.25.0/sharplsp-darwin-arm64/sharplsp")
        );
        assert!(!host.calls().iter().any(|call| call.starts_with("download")));

        host.files.borrow_mut().clear();
        let mut cache = None;
        assert_eq!(
            resolve(&host, &mut cache),
            Err("network unreachable".to_owned())
        );
    }

    #[test]
    fn a_release_missing_this_platforms_asset_names_it() {
        let mut host = Fake::new();
        host.release = Ok(Release {
            version: "v0.27.0".to_owned(),
            assets: vec![],
        });
        let mut cache = None;

        let launch = resolve(&host, &mut cache);

        assert_eq!(
            launch,
            Err("SharpLsp v0.27.0 has no sharplsp-darwin-arm64.tar.gz asset".to_owned())
        );
        assert_eq!(cache, None, "a failed download must not poison the cache");
    }

    #[test]
    fn an_unreleased_platform_gets_install_guidance_without_touching_github() {
        let mut host = Fake::new();
        host.platform = (zed::Os::Mac, zed::Architecture::X8664);
        let mut cache = None;

        let Err(message) = resolve(&host, &mut cache) else {
            panic!("Intel macOS has no release archive");
        };

        assert!(message.contains("no server for macOS x86-64."), "{message}");
        assert!(message.contains("lsp.sharplsp.binary.path"), "{message}");
        assert!(
            message.contains(&format!("github.com/{REPOSITORY}")),
            "{message}"
        );
        assert_eq!(host.calls(), ["which"]);
    }

    #[test]
    fn windows_downloads_the_zip() {
        let mut host = Fake::new();
        host.platform = (zed::Os::Windows, zed::Architecture::X8664);
        let mut cache = None;

        let launch = resolve(&host, &mut cache);

        assert_eq!(
            launch.map(|launch| launch.command).as_deref(),
            Ok("sharplsp-v0.26.0/sharplsp-win32-x64/sharplsp.exe")
        );
        assert!(host
            .calls()
            .iter()
            .any(|call| call.ends_with("sharplsp-win32-x64.zip -> sharplsp-v0.26.0 zip=true")));
    }
}
