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
