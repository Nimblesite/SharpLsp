#!/usr/bin/env node
// Implements [SHARPLSP-ARCHITECTURE-STRUCTURED-EDITS].
//
// Production source never writes an MSBuild project, a solution or an
// extension manifest as one string: those files are edited through a DOM, the
// C# sidecar's `ProjectRootElement`, so comments, conditions, child elements
// and line endings survive. Line splicing once corrupted multi-line
// `<PackageReference>` items (#4) and spliced compile items past a comment.
//
// The gate fails on a whole-file write call with such a file's extension on
// the same line, in production source only: tests and fixtures write fixture
// projects on purpose.
//
// Usage: node tools/ci/structured-file-writes.mjs [repository root, default this one]
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STRUCTURED_FILE = String.raw`\.(csproj|fsproj|props|targets|sln|slnx|vsixmanifest)\b`;

/** The whole-file writes that bypass the DOM: TypeScript, .NET and Rust. */
const BANNED_WRITES = [
    String.raw`fs\.writeFileSync\(`,
    String.raw`File\.WriteAllText\(`,
    String.raw`std::fs::write\(`,
].map((call) => new RegExp(`${call}.*${STRUCTURED_FILE}`));

/** The write calls `git grep` collects before {@link bannedWrite} judges each line. */
const WRITE_CALLS = String.raw`writeFileSync|WriteAllText|fs::write`;

/** Production source: tests, fixtures and the website write fixture projects. */
const PRODUCTION = [
    "src",
    ":!src/sharplsp/tests",
    ":!src/website",
    ":!**/test/**",
    ":!**/*.Tests/**",
    ":!**/*_tests.rs",
    ":!**/fixtures/**",
    ":!**/node_modules/**",
];

/** Whether one line of source writes a structured file as a whole string. */
export function bannedWrite(line) {
    return BANNED_WRITES.some((pattern) => pattern.test(line));
}

/** Every `path:line:text` under the git repository `root` that writes one. */
export function violations(root) {
    const grep = spawnSync(
        "git",
        ["grep", "-n", "-I", "-E", WRITE_CALLS, "--", ...PRODUCTION],
        { cwd: root, encoding: "utf8" },
    );
    if (grep.status === 1) return [];
    if (grep.status !== 0) throw new Error(`git grep failed: ${grep.stderr}`);
    return grep.stdout
        .split("\n")
        .filter((hit) => bannedWrite(hit.split(":").slice(2).join(":")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root =
        process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const found = violations(root);
    if (found.length > 0) {
        process.stderr.write(
            `Structured files are edited through ProjectRootElement, never written as a string ` +
                `([SHARPLSP-ARCHITECTURE-STRUCTURED-EDITS]):\n${found.join("\n")}\n`,
        );
        process.exit(1);
    }
    process.stdout.write("Structured-file writes: none outside the project DOM.\n");
}
