//! Genuine kernel observation loss, shared by real compiler consumers. [LSP-PULL-WATCH]
use std::path::Path;

/// Distinct irrelevant names fill the stopped reader's actual inotify queue.
pub fn saturate(root: &Path, phase: &str) {
    let capacity: usize = std::fs::read_to_string("/proc/sys/fs/inotify/max_queued_events")
        .expect("native inotify queue capacity")
        .trim()
        .parse()
        .expect("numeric queue capacity");
    assert!(capacity > 0, "a real native queue is configured");
    for index in 0..=capacity {
        std::fs::write(root.join(format!("{phase}-{index}.tmp")), b"{}")
            .expect("write real native queue input");
    }
}
