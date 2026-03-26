//! Heap snapshot diffing — compare two `dumpheap -stat` results to identify
//! memory leaks and growing types.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tracing::info;

use super::heap_analysis::{analyze_heap, AnalyzeHeapParams, HeapTypeInfo};

/// Parameters for diffing two heap snapshots.
#[derive(Debug, Deserialize)]
pub struct DiffHeapSnapshotsParams {
    pub baseline_dump_path: String,
    pub comparison_dump_path: String,
    #[serde(default = "default_growing_only")]
    pub growing_only: bool,
    #[serde(default = "default_min_growth_percent")]
    pub min_growth_percent: f64,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

/// Result of a heap snapshot diff.
#[derive(Debug, Serialize)]
pub struct HeapDiffResult {
    pub baseline_total_objects: u64,
    pub baseline_total_size_bytes: u64,
    pub comparison_total_objects: u64,
    pub comparison_total_size_bytes: u64,
    /// Types sorted by size growth descending.
    pub diffs: Vec<HeapTypeDiff>,
    /// Types flagged as probable leaks.
    pub leak_suspects: Vec<LeakSuspect>,
}

/// Per-type diff between two heap snapshots.
#[derive(Debug, Clone, Serialize)]
pub struct HeapTypeDiff {
    pub type_name: String,
    pub baseline_count: u64,
    pub comparison_count: u64,
    pub count_delta: i64,
    pub baseline_size_bytes: u64,
    pub comparison_size_bytes: u64,
    pub size_delta_bytes: i64,
    pub growth_percent: f64,
}

/// A leak suspect identified from snapshot diffing.
#[derive(Debug, Serialize)]
pub struct LeakSuspect {
    pub type_name: String,
    pub severity: LeakSeverity,
    pub reason: String,
    pub count_delta: i64,
    pub size_delta_bytes: i64,
}

/// Severity level for leak suspects.
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LeakSeverity {
    High,
    Medium,
    Low,
}

/// Known leak-prone type patterns.
const LEAK_PRONE_PATTERNS: &[&str] = &[
    "EventHandler",
    "Delegate",
    "CancellationTokenSource",
    "Timer",
    "System.Threading.Timer",
    "System.Timers.Timer",
    "WeakReference",
];

/// Diff two heap snapshots and classify leak suspects.
pub async fn diff_snapshots(params: DiffHeapSnapshotsParams) -> Result<HeapDiffResult> {
    info!(
        baseline = %params.baseline_dump_path,
        comparison = %params.comparison_dump_path,
        "Diffing heap snapshots"
    );

    let baseline_params = AnalyzeHeapParams {
        dump_path: params.baseline_dump_path.clone(),
        limit: usize::MAX,
        type_filter: None,
    };
    let comparison_params = AnalyzeHeapParams {
        dump_path: params.comparison_dump_path.clone(),
        limit: usize::MAX,
        type_filter: None,
    };

    let baseline = analyze_heap(baseline_params).await?;
    let comparison = analyze_heap(comparison_params).await?;

    let baseline_total_objects = baseline.total_objects;
    let baseline_total_size_bytes = baseline.total_size_bytes;
    let comparison_total_objects = comparison.total_objects;
    let comparison_total_size_bytes = comparison.total_size_bytes;

    let mut diffs = compute_diffs(&baseline.types, &comparison.types);

    if params.growing_only {
        diffs.retain(|d| d.count_delta > 0 || d.size_delta_bytes > 0);
    }

    diffs.retain(|d| d.growth_percent >= params.min_growth_percent);
    diffs.sort_by(|a, b| b.size_delta_bytes.cmp(&a.size_delta_bytes));
    diffs.truncate(params.limit);

    let leak_suspects = classify_suspects(&diffs);

    info!(
        diff_count = diffs.len(),
        suspect_count = leak_suspects.len(),
        "Heap diff complete"
    );

    Ok(HeapDiffResult {
        baseline_total_objects,
        baseline_total_size_bytes,
        comparison_total_objects,
        comparison_total_size_bytes,
        diffs,
        leak_suspects,
    })
}

/// Build the diff list from two sets of heap type info.
fn compute_diffs(baseline: &[HeapTypeInfo], comparison: &[HeapTypeInfo]) -> Vec<HeapTypeDiff> {
    use std::collections::HashMap;

    let baseline_map: HashMap<&str, &HeapTypeInfo> =
        baseline.iter().map(|t| (t.type_name.as_str(), t)).collect();

    let comparison_map: HashMap<&str, &HeapTypeInfo> = comparison
        .iter()
        .map(|t| (t.type_name.as_str(), t))
        .collect();

    let mut all_types: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for t in baseline {
        all_types.insert(t.type_name.as_str());
    }
    for t in comparison {
        all_types.insert(t.type_name.as_str());
    }

    all_types
        .into_iter()
        .map(|name| {
            build_diff(
                name,
                baseline_map.get(name).copied(),
                comparison_map.get(name).copied(),
            )
        })
        .collect()
}

fn build_diff(
    type_name: &str,
    baseline: Option<&HeapTypeInfo>,
    comparison: Option<&HeapTypeInfo>,
) -> HeapTypeDiff {
    let baseline_count = baseline.map_or(0, |t| t.count);
    let baseline_size = baseline.map_or(0, |t| t.total_size_bytes);
    let comparison_count = comparison.map_or(0, |t| t.count);
    let comparison_size = comparison.map_or(0, |t| t.total_size_bytes);

    let count_delta = saturating_delta(comparison_count, baseline_count);
    let size_delta = saturating_delta(comparison_size, baseline_size);
    let growth_percent = compute_growth_percent(baseline_size, size_delta);

    HeapTypeDiff {
        type_name: type_name.to_string(),
        baseline_count,
        comparison_count,
        count_delta,
        baseline_size_bytes: baseline_size,
        comparison_size_bytes: comparison_size,
        size_delta_bytes: size_delta,
        growth_percent,
    }
}

/// Compute a signed delta: `after - before`, saturating at i64 bounds.
fn saturating_delta(after: u64, before: u64) -> i64 {
    let a = i64::try_from(after).unwrap_or(i64::MAX);
    let b = i64::try_from(before).unwrap_or(i64::MAX);
    a.saturating_sub(b)
}

/// Compute growth as a percentage of baseline. Returns 100.0 for new types, 0.0 for zero baseline.
#[expect(
    clippy::cast_precision_loss,
    reason = "f64 precision sufficient for displaying heap growth percentages"
)]
#[expect(
    clippy::as_conversions,
    reason = "no From<i64>/From<u64> for f64; precision loss is acceptable for percentages"
)]
fn compute_growth_percent(baseline_size: u64, size_delta: i64) -> f64 {
    if baseline_size == 0 {
        if size_delta > 0 {
            100.0
        } else {
            0.0
        }
    } else {
        (size_delta as f64 / baseline_size as f64) * 100.0
    }
}

/// Classify leak suspects from the diff list.
fn classify_suspects(diffs: &[HeapTypeDiff]) -> Vec<LeakSuspect> {
    diffs.iter().filter_map(classify_single).collect()
}

fn classify_single(diff: &HeapTypeDiff) -> Option<LeakSuspect> {
    // Only flag types that are growing.
    if diff.count_delta <= 0 && diff.size_delta_bytes <= 0 {
        return None;
    }

    let count_growth_pct = compute_growth_percent(diff.baseline_count, diff.count_delta);

    let is_leak_prone = is_leak_prone_type(&diff.type_name);
    let is_collection = diff.type_name.contains("[]")
        || diff.type_name.contains("List")
        || diff.type_name.contains("Dictionary")
        || diff.type_name.contains("HashSet")
        || diff.type_name.contains("Queue")
        || diff.type_name.contains("Stack");

    let severity = determine_severity(
        count_growth_pct,
        diff.size_delta_bytes,
        is_leak_prone,
        is_collection,
    )?;

    let reason = build_reason(diff, count_growth_pct, is_leak_prone, is_collection);

    Some(LeakSuspect {
        type_name: diff.type_name.clone(),
        severity,
        reason,
        count_delta: diff.count_delta,
        size_delta_bytes: diff.size_delta_bytes,
    })
}

fn determine_severity(
    count_growth_pct: f64,
    size_delta: i64,
    is_leak_prone: bool,
    is_collection: bool,
) -> Option<LeakSeverity> {
    let boost = is_leak_prone || is_collection;

    if count_growth_pct > 100.0 && size_delta > 1_000_000 {
        return Some(LeakSeverity::High);
    }
    // Boost leak-prone / collection types: extreme growth → High even with smaller absolute size.
    if boost && count_growth_pct > 500.0 && size_delta > 10_000 {
        return Some(LeakSeverity::High);
    }
    if count_growth_pct > 50.0 && size_delta > 100_000 {
        return Some(LeakSeverity::Medium);
    }
    if count_growth_pct > 10.0 && size_delta > 10_000 {
        return Some(LeakSeverity::Low);
    }
    // Boost leak-prone types to Low even with smaller thresholds.
    if boost && count_growth_pct > 10.0 && size_delta > 0 {
        return Some(LeakSeverity::Low);
    }
    None
}

fn is_leak_prone_type(type_name: &str) -> bool {
    LEAK_PRONE_PATTERNS
        .iter()
        .any(|pattern| type_name.contains(pattern))
}

fn build_reason(
    diff: &HeapTypeDiff,
    count_growth_pct: f64,
    is_leak_prone: bool,
    is_collection: bool,
) -> String {
    let mut parts: Vec<String> = Vec::new();

    parts.push(format!(
        "count grew {:.0}% (+{})",
        count_growth_pct, diff.count_delta
    ));

    if diff.size_delta_bytes > 0 {
        parts.push(format!("size grew {} bytes", diff.size_delta_bytes));
    }

    if is_leak_prone {
        parts.push("known leak-prone type".to_string());
    }

    if is_collection {
        parts.push("growing collection — possible unbounded accumulation".to_string());
    }

    parts.join("; ")
}

fn default_growing_only() -> bool {
    true
}

fn default_min_growth_percent() -> f64 {
    10.0
}

fn default_limit() -> usize {
    50
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
#[expect(
    clippy::indexing_slicing,
    reason = "test code — panics are the correct failure mode"
)]
#[expect(
    clippy::float_cmp,
    reason = "test code — exact float equality is fine for constant literals"
)]
mod tests {
    use super::*;

    fn make_type(name: &str, count: u64, size: u64) -> HeapTypeInfo {
        HeapTypeInfo {
            type_name: name.to_string(),
            count,
            total_size_bytes: size,
        }
    }

    #[test]
    fn test_compute_diffs_growing_type() {
        let baseline = vec![make_type("System.String", 100, 5_000)];
        let comparison = vec![make_type("System.String", 300, 15_000)];

        let diffs = compute_diffs(&baseline, &comparison);
        assert_eq!(diffs.len(), 1);

        let d = &diffs[0];
        assert_eq!(d.type_name, "System.String");
        assert_eq!(d.count_delta, 200);
        assert_eq!(d.size_delta_bytes, 10_000);
        assert!((d.growth_percent - 200.0).abs() < 0.01);
    }

    #[test]
    fn test_compute_diffs_new_type() {
        let baseline: Vec<HeapTypeInfo> = vec![];
        let comparison = vec![make_type("MyApp.LeakyService", 50, 50_000)];

        let diffs = compute_diffs(&baseline, &comparison);
        assert_eq!(diffs.len(), 1);

        let d = &diffs[0];
        assert_eq!(d.baseline_count, 0);
        assert_eq!(d.comparison_count, 50);
        assert_eq!(d.size_delta_bytes, 50_000);
        assert_eq!(d.growth_percent, 100.0);
    }

    #[test]
    fn test_compute_diffs_shrinking_type() {
        let baseline = vec![make_type("TempObject", 1000, 40_000)];
        let comparison = vec![make_type("TempObject", 200, 8_000)];

        let diffs = compute_diffs(&baseline, &comparison);
        let d = &diffs[0];
        assert!(d.count_delta < 0);
        assert!(d.size_delta_bytes < 0);
    }

    #[test]
    fn test_classify_high_severity() {
        let diff = HeapTypeDiff {
            type_name: "EventHandler".to_string(),
            baseline_count: 10,
            comparison_count: 1500,
            count_delta: 1490,
            baseline_size_bytes: 480,
            comparison_size_bytes: 72_000,
            size_delta_bytes: 71_520,
            growth_percent: 14_900.0,
        };

        let suspect = classify_single(&diff).unwrap();
        assert!(matches!(suspect.severity, LeakSeverity::High));
        assert!(suspect.reason.contains("known leak-prone"));
    }

    #[test]
    fn test_classify_medium_severity() {
        let diff = HeapTypeDiff {
            type_name: "MyApp.Worker".to_string(),
            baseline_count: 100,
            comparison_count: 200,
            count_delta: 100,
            baseline_size_bytes: 100_000,
            comparison_size_bytes: 250_000,
            size_delta_bytes: 150_000,
            growth_percent: 150.0,
        };

        let suspect = classify_single(&diff).unwrap();
        assert!(matches!(suspect.severity, LeakSeverity::Medium));
    }

    #[test]
    fn test_classify_no_suspect_for_shrinking() {
        let diff = HeapTypeDiff {
            type_name: "System.String".to_string(),
            baseline_count: 1000,
            comparison_count: 800,
            count_delta: -200,
            baseline_size_bytes: 50_000,
            comparison_size_bytes: 40_000,
            size_delta_bytes: -10_000,
            growth_percent: -20.0,
        };

        assert!(classify_single(&diff).is_none());
    }

    #[test]
    fn test_classify_collection_growth() {
        let diff = HeapTypeDiff {
            type_name: "System.Collections.Generic.List`1[[System.String]]".to_string(),
            baseline_count: 50,
            comparison_count: 80,
            count_delta: 30,
            baseline_size_bytes: 20_000,
            comparison_size_bytes: 40_000,
            size_delta_bytes: 20_000,
            growth_percent: 100.0,
        };

        let suspect = classify_single(&diff).unwrap();
        assert!(suspect.reason.contains("growing collection"));
    }

    #[test]
    fn test_classify_suspects_filters_by_threshold() {
        // Small, non-suspect growth below thresholds.
        let diff = HeapTypeDiff {
            type_name: "System.Object".to_string(),
            baseline_count: 1000,
            comparison_count: 1010,
            count_delta: 10,
            baseline_size_bytes: 100_000,
            comparison_size_bytes: 101_000,
            size_delta_bytes: 1_000,
            growth_percent: 1.0,
        };

        assert!(classify_single(&diff).is_none());
    }

    #[test]
    fn test_is_leak_prone_type() {
        assert!(is_leak_prone_type("System.EventHandler`1[[MyArgs]]"));
        assert!(is_leak_prone_type(
            "System.Threading.CancellationTokenSource"
        ));
        assert!(is_leak_prone_type("System.Timers.Timer"));
        assert!(!is_leak_prone_type("System.String"));
        assert!(!is_leak_prone_type("MyApp.Service"));
    }

    #[test]
    fn test_growing_only_filter() {
        let baseline = vec![
            make_type("System.String", 1000, 50_000),
            make_type("EventHandler", 10, 480),
        ];
        let comparison = vec![
            make_type("System.String", 800, 40_000), // shrinking
            make_type("EventHandler", 1500, 72_000), // growing
        ];

        let mut diffs = compute_diffs(&baseline, &comparison);
        // Apply growing_only filter.
        diffs.retain(|d| d.count_delta > 0 || d.size_delta_bytes > 0);

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].type_name, "EventHandler");
    }

    #[test]
    fn test_compute_growth_percent_zero_baseline_positive_delta() {
        assert_eq!(compute_growth_percent(0, 100), 100.0);
    }

    #[test]
    fn test_compute_growth_percent_zero_baseline_zero_delta() {
        assert_eq!(compute_growth_percent(0, 0), 0.0);
    }

    #[test]
    fn test_compute_growth_percent_normal() {
        let pct = compute_growth_percent(1000, 500);
        assert!((pct - 50.0).abs() < 0.01);
    }

    #[test]
    fn test_compute_growth_percent_negative_delta() {
        let pct = compute_growth_percent(1000, -250);
        assert!((pct - (-25.0)).abs() < 0.01);
    }

    #[test]
    fn test_saturating_delta_normal() {
        assert_eq!(saturating_delta(300, 100), 200);
        assert_eq!(saturating_delta(100, 300), -200);
    }

    #[test]
    fn test_saturating_delta_zero() {
        assert_eq!(saturating_delta(0, 0), 0);
    }

    #[test]
    fn test_classify_low_severity() {
        let diff = HeapTypeDiff {
            type_name: "MyApp.Widget".to_string(),
            baseline_count: 100,
            comparison_count: 120,
            count_delta: 20,
            baseline_size_bytes: 50_000,
            comparison_size_bytes: 70_000,
            size_delta_bytes: 20_000,
            growth_percent: 40.0,
        };

        let suspect = classify_single(&diff).unwrap();
        assert!(matches!(suspect.severity, LeakSeverity::Low));
    }

    #[test]
    fn test_classify_leak_prone_boost() {
        // Small growth but leak-prone type → Low severity via boost
        let diff = HeapTypeDiff {
            type_name: "System.EventHandler`1[[MyArgs]]".to_string(),
            baseline_count: 10,
            comparison_count: 15,
            count_delta: 5,
            baseline_size_bytes: 100,
            comparison_size_bytes: 200,
            size_delta_bytes: 100,
            growth_percent: 100.0,
        };

        let suspect = classify_single(&diff).unwrap();
        assert!(matches!(suspect.severity, LeakSeverity::Low));
        assert!(suspect.reason.contains("known leak-prone"));
    }

    #[test]
    fn test_classify_collection_boost() {
        let diff = HeapTypeDiff {
            type_name: "System.Collections.Generic.Dictionary`2".to_string(),
            baseline_count: 10,
            comparison_count: 15,
            count_delta: 5,
            baseline_size_bytes: 100,
            comparison_size_bytes: 200,
            size_delta_bytes: 100,
            growth_percent: 100.0,
        };

        let suspect = classify_single(&diff).unwrap();
        assert!(suspect.reason.contains("growing collection"));
    }

    #[test]
    fn test_classify_suspects_multiple() {
        let diffs = vec![
            HeapTypeDiff {
                type_name: "LeakyType".to_string(),
                baseline_count: 10,
                comparison_count: 1500,
                count_delta: 1490,
                baseline_size_bytes: 480,
                comparison_size_bytes: 2_000_000,
                size_delta_bytes: 1_999_520,
                growth_percent: 416_566.7,
            },
            HeapTypeDiff {
                type_name: "StableType".to_string(),
                baseline_count: 100,
                comparison_count: 100,
                count_delta: 0,
                baseline_size_bytes: 5000,
                comparison_size_bytes: 5000,
                size_delta_bytes: 0,
                growth_percent: 0.0,
            },
        ];

        let suspects = classify_suspects(&diffs);
        assert_eq!(suspects.len(), 1);
        assert_eq!(suspects[0].type_name, "LeakyType");
    }

    #[test]
    fn test_build_diff_only_in_baseline() {
        let baseline = make_type("OldType", 500, 25_000);
        let diff = build_diff("OldType", Some(&baseline), None);
        assert_eq!(diff.comparison_count, 0);
        assert_eq!(diff.count_delta, -500);
        assert!(diff.size_delta_bytes < 0);
    }

    #[test]
    fn test_build_diff_only_in_comparison() {
        let comparison = make_type("NewType", 100, 5_000);
        let diff = build_diff("NewType", None, Some(&comparison));
        assert_eq!(diff.baseline_count, 0);
        assert_eq!(diff.count_delta, 100);
        assert_eq!(diff.size_delta_bytes, 5_000);
        assert_eq!(diff.growth_percent, 100.0);
    }

    #[test]
    fn test_build_reason_size_growth() {
        let diff = HeapTypeDiff {
            type_name: "MyType".to_string(),
            baseline_count: 100,
            comparison_count: 200,
            count_delta: 100,
            baseline_size_bytes: 5000,
            comparison_size_bytes: 15_000,
            size_delta_bytes: 10_000,
            growth_percent: 200.0,
        };

        let reason = build_reason(&diff, 100.0, false, false);
        assert!(reason.contains("count grew"));
        assert!(reason.contains("size grew"));
    }

    #[test]
    fn test_default_values() {
        assert!(default_growing_only());
        assert!((default_min_growth_percent() - 10.0).abs() < f64::EPSILON);
        assert_eq!(default_limit(), 50);
    }

    #[test]
    fn test_is_leak_prone_timer() {
        assert!(is_leak_prone_type("System.Threading.Timer"));
        assert!(is_leak_prone_type("System.Timers.Timer"));
        assert!(is_leak_prone_type("WeakReference`1"));
    }

    #[test]
    fn test_determine_severity_none_for_tiny_growth() {
        // Below all thresholds, not leak-prone
        let result = determine_severity(5.0, 100, false, false);
        assert!(result.is_none());
    }

    #[test]
    fn test_min_growth_filter() {
        let baseline = vec![make_type("System.String", 100, 5_000)];
        let comparison = vec![make_type("System.String", 101, 5_050)];

        let mut diffs = compute_diffs(&baseline, &comparison);
        // Apply 10% min growth filter
        diffs.retain(|d| d.growth_percent >= 10.0);
        assert!(diffs.is_empty());
    }
}
