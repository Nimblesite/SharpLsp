#!/usr/bin/env node
// Implements [DIST-VSIX-CONTENTS], [DIST-DEBUGGER-BUNDLE].
//
// Proves the packaged VSIX actually carries its native payload: the sharplsp
// host, both .NET sidecars, and the netcoredbg debug adapter. `vsce ls` prints
// exactly the file list `vsce package` writes, so an over-broad `.vscodeignore`
// or a staging step that silently no-opped is caught HERE — in seconds — rather
// than as a wall of activation failures forty minutes into a Windows chunk.
//
// Run from the extension directory.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";

/** VS Code platform id: "<platform>-<arch>". */
const PLATFORM = `${process.platform}-${process.arch}`;

/** Platforms with no upstream netcoredbg prebuilt ([DIST-DEBUGGER-BUNDLE]). */
const NO_DEBUGGER_PREBUILT = new Set(["win32-arm64", "darwin-x64"]);

const EXE = process.platform === "win32" ? ".exe" : "";

/** Every path that MUST be inside the package, and why it matters. */
function requiredEntries() {
    const required = [
        [`bin/${PLATFORM}/sharplsp${EXE}`, "the LSP host: without it nothing activates"],
        [
            `bin/all/sharplsp-sidecar-csharp${EXE}`,
            "the Roslyn sidecar: without it C# has no semantics",
        ],
        [
            `bin/all/sharplsp-sidecar-fsharp${EXE}`,
            "the FCS sidecar: without it F# has no semantics",
        ],
        ["bin/all/SharpLsp.Sidecar.CSharp.dll", "the Roslyn sidecar's managed half"],
        ["bin/all/SharpLsp.Sidecar.FSharp.dll", "the FCS sidecar's managed half"],
        ["dist/extension.js", "the extension bundle package.json `main` points at"],
    ];
    if (!NO_DEBUGGER_PREBUILT.has(PLATFORM)) {
        required.push(
            [
                `bin/${PLATFORM}/netcoredbg/netcoredbg${EXE}`,
                "the debug adapter: without it F5 fails with a spawn ENOENT",
            ],
            [
                `bin/${PLATFORM}/netcoredbg/ManagedPart.dll`,
                "the debug adapter's managed half: the launcher alone cannot debug",
            ],
        );
    }
    return required;
}

/** Paths that must NEVER ship, as predicates over a packaged path. */
const FORBIDDEN = [
    [(entry) => entry.includes("__MACOSX/"), "AppleDouble resource forks from a macOS archive"],
    [(entry) => entry.startsWith("src/"), "TypeScript sources; the bundle already has them"],
    [(entry) => entry.startsWith("out/"), "the compiled test tree"],
    [(entry) => entry.startsWith("test-fixtures/"), "test fixtures, tens of megabytes of them"],
    [(entry) => entry.endsWith(".map"), "source maps"],
];

// vsce is run as PLAIN JS THROUGH THIS NODE, never through `npx`.
//
// On Windows npm ships npx as `npx.cmd`, and there is no way to spawn it
// without a shell: the bare name is ENOENT because `execFileSync` does not
// consult PATHEXT, and naming `npx.cmd` is EINVAL because Node refuses to
// execute .cmd/.bat without `shell: true` (the CVE-2024-27980 mitigation).
// Turning the shell on would put every argument back into a quoting problem.
// Resolving vsce's own entry point and handing it to `process.execPath`
// sidesteps all of it — the same pattern tools/npm/run-sequential.mjs already
// uses for the npm CLI. Every Windows VSIX chunk ([DIST-CI-WIN-VSIX]) failed
// here, before it could check a single file.
const requireFrom = createRequire(import.meta.url);

function vsceEntryPoint() {
    const manifest = requireFrom.resolve("@vscode/vsce/package.json", {
        paths: [process.cwd()],
    });
    const { bin } = requireFrom(manifest);
    const relative = typeof bin === "string" ? bin : bin.vsce;
    return path.join(path.dirname(manifest), relative);
}

function packagedEntries() {
    const stdout = execFileSync(process.execPath, [vsceEntryPoint(), "ls", "--no-dependencies"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    return stdout
        .split(/\r?\n/)
        .map((line) => line.trim().replaceAll("\\", "/"))
        .filter((line) => line.length > 0);
}

function main() {
    const entries = new Set(packagedEntries());
    const problems = [];

    for (const [entry, why] of requiredEntries()) {
        if (!entries.has(entry)) {
            problems.push(`MISSING ${entry} — ${why}`);
        }
    }
    for (const [matches, why] of FORBIDDEN) {
        const offenders = [...entries].filter(matches);
        if (offenders.length > 0) {
            problems.push(
                `FORBIDDEN ${offenders.length} entr${offenders.length === 1 ? "y" : "ies"} — ${why}` +
                    ` (e.g. ${offenders[0]})`,
            );
        }
    }

    if (problems.length > 0) {
        process.stderr.write(
            `VSIX payload check failed for ${PLATFORM}:\n  ${problems.join("\n  ")}\n` +
                `Run 'make _stage-vsix-binary' to build and stage the full payload.\n`,
        );
        process.exit(1);
    }
    process.stderr.write(
        `VSIX payload OK for ${PLATFORM}: ${entries.size} files, host + both sidecars` +
            `${NO_DEBUGGER_PREBUILT.has(PLATFORM) ? " (no netcoredbg prebuilt for this platform)" : " + netcoredbg"}.\n`,
    );
}

try {
    main();
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
}
