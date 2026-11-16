//! A lane is one per directory, whatever the spelling, and holds a second
//! taker until the first lets go. [NUGET-REQUESTS-INSTALLED]
use std::sync::Arc;
use std::time::Duration;

use super::lane;

#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries runtime errors"
)]
fn projects_in_one_directory_share_a_lane_and_take_it_in_turn() -> anyhow::Result<()> {
    let base = std::env::temp_dir();
    let project = base.join("slsp-lane").join("App.csproj");
    let props = base.join("slsp-lane").join("Directory.Build.props");
    let other = base.join("slsp-lane-other").join("App.csproj");
    let first = lane(&project.to_string_lossy())?;
    assert!(
        Arc::ptr_eq(&first, &lane(&props.to_string_lossy())?),
        "a props file restores in its project's lane"
    );
    assert!(
        !Arc::ptr_eq(&first, &lane(&other.to_string_lossy())?),
        "another directory restores in its own lane"
    );

    let runtime = tokio::runtime::Runtime::new()?;
    let held = runtime.block_on(Arc::clone(&first).lock_owned());
    let waiting = runtime.block_on(async {
        tokio::time::timeout(Duration::from_millis(50), first.lock())
            .await
            .is_err()
    });
    assert!(
        waiting,
        "a second restore waits while the first holds the lane"
    );
    drop(held);
    let free = runtime.block_on(async {
        tokio::time::timeout(Duration::from_millis(50), first.lock())
            .await
            .is_ok()
    });
    assert!(free, "the lane opens once the first restore lets go");
    Ok(())
}

/// Memory leak: every directory ever restored kept its lane for the host's
/// life, so a long session across many projects and solution switches only
/// ever grew the map. An idle lane is dropped; a held one survives.
#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries runtime errors"
)]
fn idle_lanes_are_dropped_and_held_ones_kept() -> anyhow::Result<()> {
    let base = std::env::temp_dir().join("slsp-lane-retention");
    let project = |n: usize| base.join(format!("P{n}")).join("App.csproj");
    let held = lane(&project(0).to_string_lossy())?;
    for n in 1..=200 {
        drop(lane(&project(n).to_string_lossy())?);
    }
    let _next = lane(&base.join("Next").join("App.csproj").to_string_lossy())?;

    let lanes = super::LANES.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    let kept = lanes
        .keys()
        .filter(|key| key.contains("slsp-lane-retention") || key.contains("SLSP-LANE-RETENTION"))
        .count();
    assert_eq!(kept, 2, "only the held lane and the newest one stay");
    drop(lanes);
    assert!(
        Arc::ptr_eq(&held, &lane(&project(0).to_string_lossy())?),
        "a held lane is still the one its directory's next restore takes"
    );
    Ok(())
}
