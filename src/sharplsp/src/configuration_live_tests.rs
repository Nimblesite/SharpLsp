//! Live reconfiguration: which file changes count, which directories are
//! watched, which changed settings take a restart and how the user hears of it,
//! and a real edit reaching the main loop. Implements [CONFIG-RESOLUTION-LIVE].
use super::*;

use anyhow::{bail, Context};
use serde_json::json;

/// How long a real native change may take to arrive before the test fails.
const ARRIVAL: Duration = Duration::from_secs(20);

#[test]
fn a_configuration_file_or_lost_observation_counts_and_other_files_do_not() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let toml = dir.path().join(CONFIG_FILE_NAME);
    let personal = dir.path().join("personal.toml");
    let source = dir.path().join("Program.cs");

    // 1. Any `sharplsp.toml`, touched or removed, counts.
    assert!(touches_configuration(
        &ChangeEvent::Touched(vec![toml.clone()]),
        None
    ));
    assert!(touches_configuration(
        &ChangeEvent::Removed(vec![toml]),
        None
    ));

    // 2. So does the personal file, and only it among other names.
    assert!(touches_configuration(
        &ChangeEvent::Touched(vec![personal.clone()]),
        Some(&personal)
    ));
    assert!(!touches_configuration(
        &ChangeEvent::Touched(vec![source.clone()]),
        Some(&personal)
    ));
    assert!(!touches_configuration(
        &ChangeEvent::Removed(vec![source]),
        None
    ));

    // 3. A lost observation may have hidden one, so it counts too.
    assert!(touches_configuration(&ChangeEvent::Rescan, None));
    Ok(())
}

#[test]
fn the_root_the_nearest_file_above_it_and_the_personal_file_are_watched_once() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let repository = dir.path().join("repo");
    let root = repository.join("app");
    let home = dir.path().join("home");
    std::fs::create_dir_all(&root)?;
    let personal = home.join("config.toml");

    // 1. With no `sharplsp.toml` yet: the root, where one may appear, and the personal file's directory.
    assert_eq!(
        watched_directories(&root, Some(&personal)),
        [root.clone(), home.clone()]
    );

    // 2. The nearest one above the root adds its directory.
    std::fs::write(repository.join(CONFIG_FILE_NAME), "")?;
    assert_eq!(
        watched_directories(&root, Some(&personal)),
        [root.clone(), repository, home]
    );

    // 3. One in the root itself is the root's directory, watched once.
    std::fs::write(root.join(CONFIG_FILE_NAME), "")?;
    assert_eq!(watched_directories(&root, None), [root]);
    Ok(())
}

#[test]
fn only_settings_read_at_startup_take_a_restart() {
    let previous = SharpLspConfig::default();

    // 1. Analyzer and diagnostic settings apply live.
    let mut live = previous.clone();
    live.analyzers.monorepo = !live.analyzers.monorepo;
    live.diagnostics.analyzers_enabled = !live.diagnostics.analyzers_enabled;
    assert_eq!(restart_only_changes(&previous, &live), Vec::<&str>::new());

    // 2. The server's own settings and a compiler's switch take a restart, named in order.
    let mut restart = previous.clone();
    restart.server.log_level = "trace".to_owned();
    restart.fsharp.enabled = !restart.fsharp.enabled;
    assert_eq!(
        restart_only_changes(&previous, &restart),
        ["[server]", "[fsharp] enabled"]
    );

    // 3. So does the profiler.
    let mut profiler = previous.clone();
    profiler.profiler.max_concurrent_sessions += 1;
    assert_eq!(restart_only_changes(&previous, &profiler), ["[profiler]"]);
}

#[test]
fn a_restart_only_change_warns_the_user_and_an_unchanged_one_is_silent() -> Result<()> {
    let (client, received) = crossbeam_channel::unbounded();
    let previous = SharpLspConfig::default();
    let mut current = previous.clone();
    current.csharp.enabled = !current.csharp.enabled;

    // 1. The user is warned, naming the setting.
    notify_restart_only(&previous, &current, &client);
    let Message::Notification(notice) = received.try_recv()? else {
        bail!("the warning is a notification");
    };
    assert_eq!(notice.method, "window/showMessage");
    assert_eq!(notice.params.get("type"), Some(&json!(2)), "a warning");
    let message = notice
        .params
        .get("message")
        .and_then(Value::as_str)
        .context("a message")?;
    assert!(message.contains("[csharp] enabled"), "{message}");

    // 2. Nothing changed, nothing said.
    notify_restart_only(&current, &current, &client);
    assert!(received.try_recv().is_err());
    Ok(())
}

#[test]
fn editing_the_root_configuration_tells_the_main_loop() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let runtime = tokio::runtime::Runtime::new()?;
    let (inbound, received) = crossbeam_channel::unbounded();
    let watch = ConfigWatch::start(dir.path(), runtime.handle(), &inbound);
    assert!(!watch.tasks.is_empty(), "the root is watched");

    // A new `sharplsp.toml` in the root reaches the loop as one configuration notice.
    std::fs::write(
        dir.path().join(CONFIG_FILE_NAME),
        "[analyzers]\nmonorepo = true\n",
    )?;
    let Message::Notification(notice) = received.recv_timeout(ARRIVAL)? else {
        bail!("the change is a notification");
    };
    assert_eq!(notice.method, CONFIGURATION_FILES_CHANGED);
    Ok(())
}
