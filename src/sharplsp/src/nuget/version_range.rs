//! `NuGet` `VersionRange` parsing for advisory ranges. Implements [PKG-VULN-FIX].
//!
//! Advisory pages express affected versions as `NuGet` range strings — `"(, 5.8.4)"`,
//! `"[1.0.0, 1.2.0]"`, or a bare exact version. Ordering follows `NuGet` version
//! semantics through [`super::update`]'s comparison — never lexical.

use std::cmp::Ordering;

use anyhow::{Context, Result};

use super::update::{compare_versions, parse_version};

/// One inclusive/exclusive bound of a range.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Bound {
    /// The bound's version.
    version: NuVersion,
    /// Whether the bound itself is inside the range.
    inclusive: bool,
}

/// Re-exported parsed version handle.
type NuVersion = super::update::NuGetVersion;

/// A parsed `NuGet` version range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionRangeSpec {
    /// Lower bound, when present.
    min: Option<Bound>,
    /// Upper bound, when present.
    max: Option<Bound>,
}

impl VersionRangeSpec {
    /// Whether `version` falls inside the range.
    pub fn satisfies(&self, version: &str) -> bool {
        let Ok(parsed) = parse_version(version) else {
            return false;
        };
        self.satisfies_parsed(&parsed)
    }

    /// The range test on an already-parsed version.
    fn satisfies_parsed(&self, version: &NuVersion) -> bool {
        let above_min =
            self.min
                .as_ref()
                .is_none_or(|bound| match compare_versions(version, &bound.version) {
                    Ordering::Less => false,
                    Ordering::Equal => bound.inclusive,
                    Ordering::Greater => true,
                });
        let below_max =
            self.max
                .as_ref()
                .is_none_or(|bound| match compare_versions(version, &bound.version) {
                    Ordering::Greater => false,
                    Ordering::Equal => bound.inclusive,
                    Ordering::Less => true,
                });
        above_min && below_max
    }
}

/// Parse one range string: `"[1.0.0, 1.2.0]"`, `"(, 5.8.4)"`, `"1.0.0"`, `"[1.0.0]"`.
pub fn parse_range(text: &str) -> Result<VersionRangeSpec> {
    let text = text.trim();
    // Brackets may mismatch, as in `NuGet`'s own `[2.0.0, )` normalized form:
    // the leading bracket decides inclusivity; a lone bracket is malformed.
    let inclusive = text.starts_with('[');
    if let Some(opened) = text.strip_prefix(['[', '(']) {
        let Some(body) = opened.strip_suffix([')', ']']) else {
            anyhow::bail!("invalid range {text:?}");
        };
        return bounded(body, inclusive, text);
    }
    // A bare version is an exact, inclusive match.
    Ok(exact(
        parse_version(text).with_context(|| format!("invalid range {text:?}"))?,
    ))
}

/// An exact single-version range: both bounds at `version`, inclusive.
fn exact(version: NuVersion) -> VersionRangeSpec {
    VersionRangeSpec {
        min: Some(Bound {
            version: version.clone(),
            inclusive: true,
        }),
        max: Some(Bound {
            version,
            inclusive: true,
        }),
    }
}

/// Split a bracketed body into bounds; a comma-less body is an exact range.
fn bounded(body: &str, inclusive: bool, original: &str) -> Result<VersionRangeSpec> {
    let Some((min_text, max_text)) = body.split_once(',') else {
        return Ok(exact(parse_version(body.trim()).with_context(|| {
            format!("invalid bound in range {original:?}")
        })?));
    };
    Ok(VersionRangeSpec {
        min: bound(min_text.trim(), inclusive, original)?,
        max: bound(max_text.trim(), inclusive, original)?,
    })
}

/// One side of a bracketed range; empty or wildcard text is no bound.
fn bound(text: &str, inclusive: bool, original: &str) -> Result<Option<Bound>> {
    if matches!(text, "" | ")" | "*") {
        return Ok(None);
    }
    let version =
        parse_version(text).with_context(|| format!("invalid bound {text:?} in {original:?}"))?;
    Ok(Some(Bound { version, inclusive }))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn exact_version_ranges_match_only_that_version() {
        let range = parse_range("1.0.0").unwrap();
        assert!(range.satisfies("1.0.0"));
        assert!(!range.satisfies("1.0.1"));
        assert!(!range.satisfies("0.9.9"));
    }

    #[test]
    fn bracketed_ranges_are_inclusive() {
        let range = parse_range("[1.0.0, 1.2.0]").unwrap();
        assert!(range.satisfies("1.0.0"));
        assert!(range.satisfies("1.1.0"));
        assert!(range.satisfies("1.2.0"));
        assert!(!range.satisfies("1.2.1"));
        assert!(!range.satisfies("0.9.9"));
    }

    #[test]
    fn open_ended_ranges_bound_one_side_only() {
        let below = parse_range("(, 5.8.4)").unwrap();
        assert!(below.satisfies("1.0.0"));
        assert!(!below.satisfies("5.8.4"), "exclusive max");
        let above = parse_range("[2.0.0, )").unwrap();
        assert!(above.satisfies("2.0.0"), "inclusive min");
        assert!(above.satisfies("9.9.9"));
        assert!(!above.satisfies("1.9.9"));
    }

    #[test]
    fn parentheses_are_exclusive_on_both_bounds() {
        let range = parse_range("(1.0.0, 2.0.0)").unwrap();
        assert!(!range.satisfies("1.0.0"));
        assert!(range.satisfies("1.5.0"));
        assert!(!range.satisfies("2.0.0"));
    }

    /// `NuGet` ordering, not lexical: 1.10.0 > 1.9.0.
    #[test]
    fn ordering_is_nuget_semantic_not_lexical() {
        let range = parse_range("[1.9.0, 1.10.0]").unwrap();
        assert!(range.satisfies("1.10.0"));
        assert!(!range.satisfies("1.10.1"));
    }

    #[test]
    fn bracketed_single_version_is_exact() {
        let range = parse_range("[1.0.0]").unwrap();
        assert!(range.satisfies("1.0.0"));
        assert!(!range.satisfies("1.0.1"));
        assert!(!range.satisfies("2.0.0"));
    }

    #[test]
    fn malformed_ranges_are_rejected() {
        for text in ["[1.0.0", "not-a-version", "[]", "[1.0.0, abc]"] {
            assert!(parse_range(text).is_err(), "accepted {text}");
        }
    }

    #[test]
    fn malformed_versions_never_satisfy() {
        let range = parse_range("[1.0.0, 2.0.0]").unwrap();
        assert!(!range.satisfies("garbage"));
        assert!(!range.satisfies(""));
    }
}
