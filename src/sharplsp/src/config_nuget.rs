//! `[nuget.vulnerabilities]` configuration. Implements [PKG-VULN-SEVERITY].

use serde::{Deserialize, Serialize};

/// `NuGet` package-maintenance settings.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct NuGetConfig {
    /// Advisory-severity → diagnostic-severity mapping.
    pub vulnerabilities: VulnerabilityConfig,
}

/// How each advisory severity is reported. Defaults — high and critical are red:
///
/// ```toml
/// [nuget.vulnerabilities]
/// critical = "error"        # NU1904
/// high = "error"            # NU1903
/// moderate = "warning"      # NU1902
/// low = "information"       # NU1901
/// enforce_in_build = false  # true => error-mapped codes also fail `dotnet build`
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct VulnerabilityConfig {
    /// Critical advisories (`NU1904`).
    pub critical: MappedSeverity,
    /// High advisories (`NU1903`).
    pub high: MappedSeverity,
    /// Moderate advisories (`NU1902`).
    pub moderate: MappedSeverity,
    /// Low advisories (`NU1901`).
    pub low: MappedSeverity,
    /// Also write error-mapped codes into `WarningsAsErrors` so the build fails.
    /// Shared rule of the update fix ([FIXALL-RULES-TABLE]).
    pub enforce_in_build: bool,
}

impl Default for VulnerabilityConfig {
    fn default() -> Self {
        Self {
            critical: MappedSeverity::Error,
            high: MappedSeverity::Error,
            moderate: MappedSeverity::Warning,
            low: MappedSeverity::Information,
            enforce_in_build: false,
        }
    }
}

/// One mapped LSP severity; `None` suppresses the diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MappedSeverity {
    /// Red — fails the build when `enforce_in_build` is set.
    Error,
    /// Yellow.
    Warning,
    /// Informational.
    #[default]
    Information,
    /// Faint.
    Hint,
    /// Not reported at all.
    None,
}

impl MappedSeverity {
    /// The LSP severity number, or `None` for [`MappedSeverity::None`].
    pub fn lsp(self) -> Option<lsp_types::DiagnosticSeverity> {
        match self {
            Self::Error => Some(lsp_types::DiagnosticSeverity::ERROR),
            Self::Warning => Some(lsp_types::DiagnosticSeverity::WARNING),
            Self::Information => Some(lsp_types::DiagnosticSeverity::INFORMATION),
            Self::Hint => Some(lsp_types::DiagnosticSeverity::HINT),
            Self::None => None,
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn defaults_make_high_and_critical_red() {
        let config = VulnerabilityConfig::default();
        assert_eq!(config.critical, MappedSeverity::Error);
        assert_eq!(config.high, MappedSeverity::Error);
        assert_eq!(config.moderate, MappedSeverity::Warning);
        assert_eq!(config.low, MappedSeverity::Information);
        assert!(!config.enforce_in_build);
    }

    /// Unknown keys and values are config errors, never silently ignored.
    #[test]
    fn unknown_keys_and_values_are_rejected() {
        for toml in [
            "[nuget.vulnerabilities]\nbogus = \"error\"\n",
            "[nuget.vulnerabilities]\nhigh = \"severe\"\n",
            "[nuget.vulnerabilities]\nhigh = 3\n",
            "[nuget]\nvulnerabilities = true\n",
        ] {
            let parsed: Result<crate::config::SharpLspConfig, _> = toml::from_str(toml);
            assert!(parsed.is_err(), "accepted {toml}");
        }
    }

    #[test]
    fn every_severity_value_parses() {
        for (value, expected) in [
            ("error", MappedSeverity::Error),
            ("warning", MappedSeverity::Warning),
            ("information", MappedSeverity::Information),
            ("hint", MappedSeverity::Hint),
            ("none", MappedSeverity::None),
        ] {
            let toml = format!("[nuget.vulnerabilities]\nhigh = \"{value}\"\n");
            let config: crate::config::SharpLspConfig = toml::from_str(&toml).unwrap();
            assert_eq!(config.nuget.vulnerabilities.high, expected, "{toml}");
            // Unset severities keep their defaults.
            assert_eq!(config.nuget.vulnerabilities.critical, MappedSeverity::Error);
        }
    }
}
