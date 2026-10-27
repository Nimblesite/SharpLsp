//! One restore at a time per project directory. `dotnet list package` restores
//! implicitly, so a listing that overlaps the background restore an install or
//! uninstall started runs two restores against the same `obj/`, and the
//! listing fails (GitHub #516). Every restore the host runs, background or a
//! listing's, takes its directory's lane first. Either order answers with the
//! mutated project, because the edit lands before both. [NUGET-REQUESTS-INSTALLED]

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use anyhow::{anyhow, Result};

/// The lane one directory's restores take in turn.
pub type Lane = Arc<tokio::sync::Mutex<()>>;

/// Every directory's lane, created on its first restore.
static LANES: LazyLock<Mutex<HashMap<String, Lane>>> = LazyLock::new(Mutex::default);

/// The lane serialising every host restore of the directory holding `target`.
pub fn lane(target: &str) -> Result<Lane> {
    let key = crate::paths::directory_key(target)
        .ok_or_else(|| anyhow!("no directory holds {target}"))?;
    let mut lanes = LANES
        .lock()
        .map_err(|poisoned| anyhow!("NuGet restore lanes poisoned: {poisoned}"))?;
    Ok(Arc::clone(lanes.entry(key).or_default()))
}

#[cfg(test)]
#[path = "lanes_tests.rs"]
mod tests;
