//! The standalone server archive a release publishes for each platform.
//! Implements [DIST-ARCHIVE] and [DIST-ARCHIVE-LAYOUT].
use zed_extension_api as zed;

use crate::server::SERVER_BINARY;

/// One platform's [DIST-ARCHIVE] asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Target {
    /// The platform segment of the asset name and of its top-level directory.
    platform: &'static str,
    /// `.zip` holding `.exe` files on Windows; `.tar.gz` everywhere else.
    windows: bool,
}

impl Target {
    /// The archive a release publishes for this OS and CPU, if it builds one.
    pub(crate) fn for_platform(os: zed::Os, arch: zed::Architecture) -> Option<Self> {
        let (platform, windows) = match (os, arch) {
            (zed::Os::Mac, zed::Architecture::Aarch64) => ("darwin-arm64", false),
            (zed::Os::Linux, zed::Architecture::X8664) => ("linux-x64", false),
            (zed::Os::Linux, zed::Architecture::Aarch64) => ("linux-arm64", false),
            (zed::Os::Windows, zed::Architecture::X8664) => ("win32-x64", true),
            (zed::Os::Windows, zed::Architecture::Aarch64) => ("win32-arm64", true),
            _ => return None,
        };
        Some(Self { platform, windows })
    }

    /// Whether the asset is a `.zip` (Windows) rather than a `.tar.gz`.
    pub(crate) fn zip(self) -> bool {
        self.windows
    }

    /// The release asset name from the [DIST-ARCHIVE] table.
    pub(crate) fn asset(self) -> String {
        let extension = if self.windows { "zip" } else { "tar.gz" };
        format!("sharplsp-{}.{extension}", self.platform)
    }

    /// The host, then both sidecar apphosts, inside a download directory.
    /// [DIST-ARCHIVE-LAYOUT] keeps the sidecars beside the host, where it finds them.
    pub(crate) fn executables(self, dir: &str) -> [String; 3] {
        let root = format!("{dir}/sharplsp-{}", self.platform);
        let exe = if self.windows { ".exe" } else { "" };
        [
            format!("{root}/{SERVER_BINARY}{exe}"),
            format!("{root}/sidecar-csharp/SharpLsp.Sidecar.CSharp{exe}"),
            format!("{root}/sidecar-fsharp/SharpLsp.Sidecar.FSharp{exe}"),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_released_platform_maps_to_its_archive_asset() {
        let cases = [
            (
                zed::Os::Mac,
                zed::Architecture::Aarch64,
                "sharplsp-darwin-arm64.tar.gz",
            ),
            (
                zed::Os::Linux,
                zed::Architecture::X8664,
                "sharplsp-linux-x64.tar.gz",
            ),
            (
                zed::Os::Linux,
                zed::Architecture::Aarch64,
                "sharplsp-linux-arm64.tar.gz",
            ),
            (
                zed::Os::Windows,
                zed::Architecture::X8664,
                "sharplsp-win32-x64.zip",
            ),
            (
                zed::Os::Windows,
                zed::Architecture::Aarch64,
                "sharplsp-win32-arm64.zip",
            ),
        ];
        for (os, arch, asset) in cases {
            let target = Target::for_platform(os, arch);
            assert_eq!(
                target.map(Target::asset).as_deref(),
                Some(asset),
                "{os:?} {arch:?}"
            );
        }
        assert_eq!(
            Target::for_platform(zed::Os::Mac, zed::Architecture::X8664),
            None
        );
        assert_eq!(
            Target::for_platform(zed::Os::Linux, zed::Architecture::X86),
            None
        );
    }

    #[test]
    fn executables_follow_the_archive_layout_on_unix_and_windows() {
        let unix = Target::for_platform(zed::Os::Linux, zed::Architecture::X8664);
        let windows = Target::for_platform(zed::Os::Windows, zed::Architecture::Aarch64);
        assert_eq!(
            unix.map(|target| target.executables("d")),
            Some([
                "d/sharplsp-linux-x64/sharplsp".to_owned(),
                "d/sharplsp-linux-x64/sidecar-csharp/SharpLsp.Sidecar.CSharp".to_owned(),
                "d/sharplsp-linux-x64/sidecar-fsharp/SharpLsp.Sidecar.FSharp".to_owned(),
            ])
        );
        let [server, csharp, fsharp] = windows
            .map(|target| target.executables("d"))
            .unwrap_or_default();
        assert_eq!(server, "d/sharplsp-win32-arm64/sharplsp.exe");
        assert_eq!(
            csharp,
            "d/sharplsp-win32-arm64/sidecar-csharp/SharpLsp.Sidecar.CSharp.exe"
        );
        assert_eq!(
            fsharp,
            "d/sharplsp-win32-arm64/sidecar-fsharp/SharpLsp.Sidecar.FSharp.exe"
        );
    }
}
