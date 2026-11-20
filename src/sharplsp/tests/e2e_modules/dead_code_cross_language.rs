//! [ANALYZERS-TRUTH] across languages, through the real host and both sidecars:
//! neither compiler sees the other language's callers, so a project the other
//! language references reports no unused PUBLIC code — at open, and as project
//! references are added or removed later.
use super::configuration_live::{write_configuration, write_project, LiveSession};
use super::*;

/// [ANALYZERS-TRUTH]: a public F# function that only C# calls is live.
/// FCS sees no C# caller, so the F# analyzer alone would call it dead — in a
/// monorepo, as an ERROR on code the solution uses.
#[test]
fn a_public_fsharp_function_only_csharp_calls_is_not_dead_in_a_monorepo() {
    require_dotnet();
    let workspace = tempfile::tempdir().expect("real mixed solution");
    let root = workspace.path();
    let library = write_project(
        root,
        "Lib",
        "fs",
        ["<OutputType>Library</OutputType>", ""],
        "module Lib.Values\n\nlet used () = 1\n\nlet orphan () = 2\n",
    );
    let _app = mixed_app(
        root,
        "cs",
        "fs",
        "internal static class Program\n{\n    private static int Main() => Lib.Values.used();\n}\n",
        true,
    );
    write_configuration(root, "[analyzers]\ndead_code = true\nmonorepo = true\n");
    let mut session = LiveSession::start(root, &library, "SLSPF0101");

    // C#'s call keeps `used` alive. FCS cannot see C# callers, so neither can it
    // prove `orphan` unused: [ANALYZERS-TRUTH] prefers silence to a false error.
    session.await_dead(&[]);
    session.client.shutdown_and_exit();
}

/// The other direction: Roslyn sees no F# caller, so a public C# type only F#
/// uses must not be reported dead either.
#[test]
fn a_public_csharp_type_only_fsharp_uses_is_not_dead_in_a_monorepo() {
    require_dotnet();
    let workspace = tempfile::tempdir().expect("real mixed solution");
    let root = workspace.path();
    let library = write_project(
        root,
        "Lib",
        "cs",
        ["<OutputType>Library</OutputType>", ""],
        "namespace Lib;\n\npublic sealed class Used { }\n\npublic sealed class Orphan { }\n",
    );
    let _app = mixed_app(
        root,
        "fs",
        "cs",
        "module App.Program\n\n[<EntryPoint>]\nlet main _ =\n    Lib.Used() |> ignore\n    0\n",
        true,
    );
    write_configuration(root, "[analyzers]\ndead_code = true\nmonorepo = true\n");
    let mut session = LiveSession::start(root, &library, "SLSPC0101");

    // F#'s use keeps `Used` alive; `Orphan` is reported only if the analyzer can
    // prove no F# code uses it, which it cannot — so neither is reported.
    session.await_dead(&[]);
    session.client.shutdown_and_exit();
}

/// [ANALYZERS-TRUTH] as the solution changes: a C# project that starts calling an
/// F# library silences that library's public dead code, and one that stops calling
/// it brings the errors back. The F# compiler never reloads for a C# project edit,
/// so it must notice the edited reference itself.
#[test]
fn a_csharp_reference_added_or_removed_later_moves_fsharp_public_dead_code() {
    require_dotnet();
    let workspace = tempfile::tempdir().expect("real mixed solution");
    let root = workspace.path();
    let library = write_project(
        root,
        "Lib",
        "fs",
        ["<OutputType>Library</OutputType>", ""],
        "module Lib.Values\n\nlet used () = 1\n\nlet orphan () = 2\n",
    );
    let app = mixed_app(
        root,
        "cs",
        "fs",
        "internal static class Program\n{\n    private static int Main() => 0;\n}\n",
        false,
    );
    write_configuration(root, "[analyzers]\ndead_code = true\nmonorepo = true\n");
    let mut session = LiveSession::start(root, &library, "SLSPF0101");

    // 1. Nothing references the library: both public functions are dead, as errors.
    session.await_dead(&[("orphan", 1), ("used", 1)]);

    // 2. The C# app now references and calls it: F# cannot see that caller, so silence.
    let _app = mixed_app(root, "cs", "fs", "internal static class Program\n{\n    private static int Main() => Lib.Values.used();\n}\n", true);
    session.await_dead(&[]);

    // 3. The reference is removed again: the errors come back.
    let _app = mixed_app(
        root,
        "cs",
        "fs",
        "internal static class Program\n{\n    private static int Main() => 0;\n}\n",
        false,
    );
    session.await_dead(&[("orphan", 1), ("used", 1)]);
    assert!(app.exists(), "the app source stayed in place throughout");
    session.client.shutdown_and_exit();
}

/// The other direction: an F# project that starts or stops using a C# library moves
/// the library's public dead code, though Roslyn never reloads for an F# project edit.
#[test]
fn an_fsharp_reference_added_or_removed_later_moves_csharp_public_dead_code() {
    require_dotnet();
    let workspace = tempfile::tempdir().expect("real mixed solution");
    let root = workspace.path();
    let library = write_project(
        root,
        "Lib",
        "cs",
        ["<OutputType>Library</OutputType>", ""],
        "namespace Lib;\n\npublic sealed class Used { }\n\npublic sealed class Orphan { }\n",
    );
    let fsharp = "module App.Program\n\n[<EntryPoint>]\nlet main _ = 0\n";
    let _app = mixed_app(root, "fs", "cs", fsharp, false);
    write_configuration(root, "[analyzers]\ndead_code = true\nmonorepo = true\n");
    let mut session = LiveSession::start(root, &library, "SLSPC0101");

    // 1. Nothing references the library: both public types are dead, as errors.
    session.await_dead(&[("Orphan", 1), ("Used", 1)]);

    // 2. The F# app now references it: Roslyn cannot see F# callers, so silence.
    let _app = mixed_app(root, "fs", "cs", fsharp, true);
    session.await_dead(&[]);

    // 3. The reference is removed again: Roslyn reports both types again.
    let _app = mixed_app(root, "fs", "cs", fsharp, false);
    session.await_dead(&[("Orphan", 1), ("Used", 1)]);
    session.client.shutdown_and_exit();
}

/// Write the `App` project in `app_ext` with `source`, referencing `Lib` (written in
/// `lib_ext`) when `referenced`, and once the `Mixed.slnx` holding both; returns the source.
fn mixed_app(root: &Path, app_ext: &str, lib_ext: &str, source: &str, referenced: bool) -> PathBuf {
    let reference = format!(
        r#"<ItemGroup><ProjectReference Include="../Lib/Lib.{lib_ext}proj" /></ItemGroup>"#
    );
    let items = if referenced { reference.as_str() } else { "" };
    let app = write_project(
        root,
        "App",
        app_ext,
        ["<OutputType>Exe</OutputType>", items],
        source,
    );
    // Written once: a rewritten solution would reload BOTH compilers and hide
    // whether the other language noticed the project edit on its own.
    let solution = root.join("Mixed.slnx");
    if !solution.exists() {
        std::fs::write(
            solution,
            format!("<Solution>\n  <Project Path=\"Lib/Lib.{lib_ext}proj\" />\n  <Project Path=\"App/App.{app_ext}proj\" />\n</Solution>\n"),
        )
        .expect("write the solution");
    }
    app
}
