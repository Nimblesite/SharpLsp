//! Inclusive heap sizes from SOS, independent of graph display limits.
//! Implements [PROFILER-GRAPH-BUILD].

use anyhow::{Context, Result};

use super::{dump_cmd, heap_analysis::parse_dumpheap_stat, object_inspection::parse_size_field};

/// Measure the object and its transitive references, including hidden graph nodes.
pub(super) async fn measure(tool: &std::path::Path, dump: &str, address: &str) -> Result<u64> {
    let output = dump_cmd::run(tool, dump, &format!("objsize {address}")).await?;
    anyhow::ensure!(output.status.success(), "SOS objsize failed for {address}");
    parse(&String::from_utf8_lossy(&output.stdout))
        .with_context(|| format!("SOS returned no inclusive size for {address}"))
}

/// SOS emits a statistics table on current runtimes, or a `sizeof(...)` summary.
fn parse(output: &str) -> Option<u64> {
    let types = parse_dumpheap_stat(output);
    if !types.is_empty() {
        return types
            .iter()
            .try_fold(0_u64, |sum, row| sum.checked_add(row.total_size_bytes));
    }
    output.lines().find_map(|line| {
        let line = line.trim().strip_prefix("sizeof(")?;
        let (_, size) = line.split_once('=')?;
        let bytes = parse_size_field(size);
        (bytes > 0).then_some(bytes)
    })
}

#[cfg(test)]
mod tests {
    use super::parse;

    /// [PROFILER-GRAPH-BUILD] Never substitute a shallow size or an error for a measurement.
    #[test]
    fn inclusive_size_reads_sos_and_rejects_missing_measurements() {
        assert_eq!(
            parse("sizeof(00001234) = 1072 (0x430) bytes (System.Text.StringBuilder)"),
            Some(1072)
        );
        assert_eq!(
            parse("Ready\r\n  sizeof(00001234) = 48 (0x30) bytes\r\n> exit"),
            Some(48)
        );
        assert_eq!(parse("Size: 48(0x30) bytes"), None);
        assert_eq!(parse("Invalid object address"), None);
        assert_eq!(parse("sizeof(00001234) = invalid bytes"), None);
        assert_eq!(parse("sizeof(00001234) = 0 (0x0) bytes"), None);
    }

    /// [PROFILER-GRAPH-BUILD] Reuse heap-statistics parsing, including SOS thousands separators.
    #[test]
    fn inclusive_size_sums_current_sos_statistics() {
        let output = "Objects which 12345678 transitively keep alive:\n12345678 12340000 48\nStatistics:\nMT Count TotalSize Class Name\n12340000 1 48 System.Text.StringBuilder\n12340008 1 1,048 System.Char[]\nTotal 2 objects, 1,096 bytes";
        assert_eq!(parse(output), Some(1096));
        assert_eq!(parse("Statistics:\nMT Count TotalSize Class Name\n"), None);
        assert_eq!(
            parse("12340000 1 18446744073709551615 System.Object\n12340008 1 48 System.String"),
            None
        );
    }
}
