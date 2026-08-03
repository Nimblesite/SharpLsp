#!/usr/bin/env node
// Implements [DIST-CI-WIN-VSIX].
//
// Single reader for src/editors/vscode/test-chunks.json — the one place the
// Windows VS Code feature chunks are declared. The Makefile (`_test-vsix-win`),
// the CI job matrix, and the completeness guard all go through this script, so
// adding a chunk or a suite is a one-file edit.
//
// Usage:
//   node tools/vsix/vsix-test-chunks.mjs files <chunk>  -> comma-separated globs for MOCHA_FILES
//   node tools/vsix/vsix-test-chunks.mjs matrix         -> JSON array of chunk names (GitHub matrix)
//   node tools/vsix/vsix-test-chunks.mjs check          -> fail if any suite is in no chunk / two chunks
//
// stdout carries the answer only (safe for command substitution); diagnostics
// and failures go to stderr with a non-zero exit.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = join(REPO_ROOT, "src", "editors", "vscode", "test-chunks.json");
const SUITE_DIR = join(REPO_ROOT, "src", "editors", "vscode", "src", "test", "suite");

function loadManifest() {
    return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

/**
 * Compiled suite names (`*.test.js`) derived from the TypeScript sources.
 *
 * Recursive, because the runner's default pattern is `**\/*.test.js` — a suite
 * placed in a subdirectory would otherwise be invisible to the guard and so
 * belong to no Windows chunk while still running in the Ubuntu full suite.
 * Paths are POSIX-separated to match the globs the runner resolves.
 */
function declaredSuites(dir = SUITE_DIR, prefix = "") {
    const suites = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            suites.push(
                ...declaredSuites(
                    join(dir, entry.name),
                    `${prefix}${entry.name}/`,
                ),
            );
        } else if (entry.name.endsWith(".test.ts")) {
            suites.push(`${prefix}${entry.name.replace(/\.ts$/, ".js")}`);
        }
    }
    return suites.sort();
}

function chunkGlobs(manifest, chunk) {
    const entry = manifest.chunks[chunk];
    if (!entry) {
        const known = Object.keys(manifest.chunks).join(", ");
        throw new Error(`unknown chunk '${chunk}'. Known chunks: ${known}`);
    }
    return [...manifest.shared.files, ...entry.files];
}

/**
 * Regex metacharacters that must be escaped to match literally. `*` and `?` are
 * absent deliberately — they are the glob wildcards, translated by `globToRegExp`.
 */
const REGEXP_METACHARACTERS = new Set([
    ".",
    "+",
    "^",
    "$",
    "{",
    "}",
    "(",
    ")",
    "|",
    "[",
    "]",
    "\\",
]);

/**
 * A glob with no wildcard is a literal filename; otherwise `*` matches any run
 * of characters and `?` exactly one. `?` MUST be translated rather than left
 * alone: as a bare regex quantifier it would make the preceding character
 * optional, so the guard would claim ownership of suites the real `glob`
 * matcher never selects — the one way a suite can read as "owned" yet run in no
 * chunk.
 */
function globToRegExp(glob) {
    let pattern = "";
    for (const char of glob) {
        if (char === "*") {
            pattern += ".*";
        } else if (char === "?") {
            pattern += ".";
        } else {
            // A direct membership test, not `char.replace(/…/, "\\$&")`. The replace form
            // is a non-global regex used for escaping, which CodeQL flags as incomplete
            // sanitization (js/incomplete-sanitization) — it cannot see that `for…of`
            // yields exactly one code point, so at most one occurrence ever exists. The
            // set says what is meant without the ambiguity, and drops a regex besides.
            pattern += REGEXP_METACHARACTERS.has(char) ? `\\${char}` : char;
        }
    }
    return new RegExp(`^${pattern}$`);
}

function matchSuites(globs, suites) {
    return suites.filter((suite) =>
        globs.some((glob) => globToRegExp(glob).test(suite)),
    );
}

function check(manifest) {
    const suites = declaredSuites();
    const owners = new Map(suites.map((suite) => [suite, []]));

    for (const [chunk, entry] of Object.entries(manifest.chunks)) {
        for (const suite of matchSuites(entry.files, suites)) {
            owners.get(suite).push(chunk);
        }
    }
    for (const suite of matchSuites(manifest.shared.files, suites)) {
        owners.get(suite).push("shared");
    }
    for (const suite of matchSuites(manifest.excluded.files, suites)) {
        owners.get(suite).push("excluded");
    }

    const orphans = [...owners]
        .filter(([, chunks]) => chunks.length === 0)
        .map(([suite]) => suite);
    const duplicates = [...owners].filter(([, chunks]) => chunks.length > 1);

    // The ownership check above is one-directional: it catches a suite no entry
    // claims, but not an entry that claims nothing. A renamed or deleted suite
    // leaves a stale glob behind, and the runner treats a zero-match glob as a
    // hard error — which would otherwise surface 30+ minutes later inside the
    // Windows chunk matrix instead of here in lint.
    const deadGlobs = [
        ...Object.entries(manifest.chunks).flatMap(([chunk, entry]) =>
            entry.files
                .filter((glob) => matchSuites([glob], suites).length === 0)
                .map((glob) => [chunk, glob]),
        ),
        ...manifest.shared.files
            .filter((glob) => matchSuites([glob], suites).length === 0)
            .map((glob) => ["shared", glob]),
        ...manifest.excluded.files
            .filter((glob) => matchSuites([glob], suites).length === 0)
            .map((glob) => ["excluded", glob]),
    ];

    const problems = [
        ...orphans.map(
            (suite) =>
                `${suite} belongs to no chunk — add it to a chunk in src/editors/vscode/test-chunks.json ` +
                `(or to "excluded" with a reason) so it cannot silently skip Windows CI.`,
        ),
        ...duplicates.map(
            ([suite, chunks]) =>
                `${suite} is claimed by more than one chunk: ${chunks.join(", ")}.`,
        ),
        ...deadGlobs.map(
            ([chunk, glob]) =>
                `chunk '${chunk}' lists '${glob}', which matches no suite — remove the stale entry ` +
                `(a zero-match glob is a hard error in the runner, so this would fail the Windows job).`,
        ),
    ];

    if (problems.length > 0) {
        process.stderr.write(`${problems.join("\n")}\n`);
        process.exit(1);
    }
    process.stderr.write(
        `${suites.length} VS Code suites: ${Object.keys(manifest.chunks).length} Windows chunks, ` +
            `${matchSuites(manifest.excluded.files, suites).length} excluded.\n`,
    );
}

function main() {
    const [command, argument] = process.argv.slice(2);
    const manifest = loadManifest();

    if (command === "files") {
        process.stdout.write(chunkGlobs(manifest, argument).join(","));
    } else if (command === "matrix") {
        process.stdout.write(JSON.stringify(Object.keys(manifest.chunks)));
    } else if (command === "check") {
        check(manifest);
    } else {
        throw new Error(
            `usage: vsix-test-chunks.mjs <files <chunk>|matrix|check>, got '${command}'`,
        );
    }
}

try {
    main();
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
}
