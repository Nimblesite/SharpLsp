//! [`Host`] over Zed's extension runtime. The WASM imports exist only inside Zed,
//! so each method is a single call; the conversions around them are plain
//! functions with their own tests.
use zed_extension_api::{
    self as zed,
    settings::{CommandSettings, LspSettings},
};

use crate::server::{
    Configured, Host, Release, Status, LANGUAGE_SERVER, REPOSITORY, SERVER_BINARY,
};

/// One language server start in one worktree.
pub(crate) struct ZedHost<'a> {
    pub(crate) id: &'a zed::LanguageServerId,
    pub(crate) worktree: &'a zed::Worktree,
}

/// The user's `lsp.sharplsp` settings, if any are set.
pub(crate) fn lsp_settings(worktree: &zed::Worktree) -> Option<LspSettings> {
    LspSettings::for_worktree(LANGUAGE_SERVER, worktree).ok()
}

/// Stable releases that carry assets: a tag still uploading has none yet.
const RELEASES: zed::GithubReleaseOptions = zed::GithubReleaseOptions {
    require_assets: true,
    pre_release: false,
};

impl Host for ZedHost<'_> {
    fn configured(&self) -> Configured {
        configured(lsp_settings(self.worktree).and_then(|settings| settings.binary))
    }

    fn which(&self) -> Option<String> {
        self.worktree.which(SERVER_BINARY)
    }

    fn platform(&self) -> (zed::Os, zed::Architecture) {
        zed::current_platform()
    }

    fn is_file(&self, path: &str) -> bool {
        is_file(path)
    }

    fn latest_release(&self) -> Result<Release, String> {
        zed::latest_github_release(REPOSITORY, RELEASES).map(release)
    }

    fn report(&self, status: Status) {
        zed::set_language_server_installation_status(self.id, &installation(status));
    }

    fn download(&self, url: &str, dir: &str, zip: bool) -> Result<(), String> {
        zed::download_file(url, dir, file_type(zip)).map_err(|error| failed(url, &error))
    }

    fn make_executable(&self, path: &str) -> Result<(), String> {
        zed::make_file_executable(path)
    }

    fn entries(&self) -> Vec<String> {
        entries(".")
    }

    fn remove(&self, dir: &str) -> Result<(), String> {
        remove(dir)
    }
}

/// `lsp.sharplsp.binary`: path, arguments and environment, each optional.
fn configured(binary: Option<CommandSettings>) -> Configured {
    binary.map_or_else(Configured::default, |binary| Configured {
        path: binary.path,
        args: binary.arguments.unwrap_or_default(),
        env: binary.env.unwrap_or_default().into_iter().collect(),
    })
}

fn release(release: zed::GithubRelease) -> Release {
    let assets = release.assets.into_iter();
    Release {
        version: release.version,
        assets: assets
            .map(|asset| (asset.name, asset.download_url))
            .collect(),
    }
}

/// `Ready` clears the indicator: Zed shows no status for a running server.
fn installation(status: Status) -> zed::LanguageServerInstallationStatus {
    match status {
        Status::Checking => zed::LanguageServerInstallationStatus::CheckingForUpdate,
        Status::Downloading => zed::LanguageServerInstallationStatus::Downloading,
        Status::Ready => zed::LanguageServerInstallationStatus::None,
    }
}

fn file_type(zip: bool) -> zed::DownloadedFileType {
    if zip {
        zed::DownloadedFileType::Zip
    } else {
        zed::DownloadedFileType::GzipTar
    }
}

fn failed(url: &str, error: &str) -> String {
    format!("download {url}: {error}")
}

// The extension's work directory is the WASM sandbox's current directory.

fn is_file(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}

fn entries(dir: &str) -> Vec<String> {
    std::fs::read_dir(dir).map_or_else(
        |_| Vec::new(),
        |entries| {
            let names = entries.flatten().map(|entry| entry.file_name());
            names.filter_map(|name| name.into_string().ok()).collect()
        },
    )
}

fn remove(dir: &str) -> Result<(), String> {
    std::fs::remove_dir_all(dir).map_err(|error| format!("remove {dir}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn binary_settings_supply_path_arguments_and_environment() {
        let settings = CommandSettings {
            path: Some("/opt/sharplsp".to_owned()),
            arguments: Some(vec!["--stdio".to_owned()]),
            env: Some(HashMap::from([(
                "DOTNET_ROOT".to_owned(),
                "/opt/dotnet".to_owned(),
            )])),
        };

        let configured = configured(Some(settings));

        assert_eq!(configured.path.as_deref(), Some("/opt/sharplsp"));
        assert_eq!(configured.args, ["--stdio"]);
        assert_eq!(
            configured.env,
            [("DOTNET_ROOT".to_owned(), "/opt/dotnet".to_owned())]
        );
        assert_eq!(configured_none(), Configured::default());
    }

    fn configured_none() -> Configured {
        configured(Some(CommandSettings {
            path: None,
            arguments: None,
            env: None,
        }))
    }

    #[test]
    fn absent_binary_settings_configure_nothing() {
        assert_eq!(configured(None), Configured::default());
        assert_eq!(configured_none().path, None);
        assert!(configured_none().args.is_empty() && configured_none().env.is_empty());
    }

    #[test]
    fn a_github_release_keeps_its_tag_and_every_asset() {
        let github = zed::GithubRelease {
            version: "v0.26.0".to_owned(),
            assets: vec![zed::GithubReleaseAsset {
                name: "sharplsp-linux-x64.tar.gz".to_owned(),
                download_url: "https://github.com/x/y.tar.gz".to_owned(),
            }],
        };

        let release = release(github);

        assert_eq!(release.version, "v0.26.0");
        assert_eq!(release.assets.len(), 1);
        assert_eq!(release.assets[0].0, "sharplsp-linux-x64.tar.gz");
        assert_eq!(release.assets[0].1, "https://github.com/x/y.tar.gz");
    }

    #[test]
    fn statuses_and_archive_types_map_to_zeds() {
        use zed::LanguageServerInstallationStatus as Zed;
        assert!(matches!(
            installation(Status::Checking),
            Zed::CheckingForUpdate
        ));
        assert!(matches!(
            installation(Status::Downloading),
            Zed::Downloading
        ));
        assert!(matches!(installation(Status::Ready), Zed::None));
        assert!(matches!(file_type(true), zed::DownloadedFileType::Zip));
        assert!(matches!(file_type(false), zed::DownloadedFileType::GzipTar));
        assert_eq!(failed("https://u", "403"), "download https://u: 403");
    }

    #[test]
    fn the_work_directory_is_listed_probed_and_pruned() -> std::io::Result<()> {
        let root = std::env::temp_dir().join(format!("sharplsp-zed-{}", std::process::id()));
        let dir = root.join("sharplsp-v0.25.0");
        let server = dir.join("sharplsp");
        std::fs::create_dir_all(&dir)?;
        std::fs::write(&server, b"")?;
        let (root_str, dir_str) = (root.to_string_lossy(), dir.to_string_lossy());

        assert_eq!(entries(&root_str), ["sharplsp-v0.25.0"]);
        assert!(is_file(&server.to_string_lossy()));
        assert!(!is_file(&dir_str), "a directory is not the server");
        assert_eq!(remove(&dir_str), Ok(()));
        assert!(entries(&root_str).is_empty());
        assert!(remove(&dir_str).is_err_and(|error| error.starts_with("remove ")));
        assert!(
            entries(&dir_str).is_empty(),
            "a missing directory lists nothing"
        );
        assert_eq!(remove(&root_str), Ok(()));
        Ok(())
    }
}
