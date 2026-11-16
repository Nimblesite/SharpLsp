#!/usr/bin/env node
// Implements [DIAG-HYGIENE-GUARD].
//
// Runs the host's own workspace diagnostics over a folder — by default this
// repository — exactly as an editor would: a real `sharplsp` over stdio, a real
// `initialize`, and `workspace/diagnostic` pulls once every project has loaded.
// It prints what the Problems panel would show and fails when a file outside
// the allow-list has a diagnostic at or above the failing severity. The
// allow-list is the fixtures that exist to demonstrate diagnostics.
//
// Usage: node tools/ci/workspace-diagnostics.mjs [--root <dir>] [--server <path>]
//          [--allow <path-part>]... [--fail-on error|warning|information|hint]
//          [--timeout <seconds>] [--list]
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSession, openSession, settledReports } from "./lsp-session.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Fixtures whose diagnostics are the point of them: the lint, tag and cancellation
 * demos, and the file the code-fix suites remove an unused open and a redundant
 * qualifier from.
 */
const DEMO_FIXTURES = ["/diagnostic-lint", "/diagnostic-tags", "/diagnostic-cancellation", "/test-fixtures/workspace/fsharp/CodeFixes.fs"];

/** LSP severities, most severe first; the index + 1 is the wire value. */
const SEVERITIES = ["error", "warning", "information", "hint"];

/** Options from the command line, with their defaults. */
export function parseArguments(argv) {
    const options = {
        root: REPO_ROOT,
        server: join(REPO_ROOT, "target", "debug", process.platform === "win32" ? "sharplsp.exe" : "sharplsp"),
        allow: [...DEMO_FIXTURES],
        failOn: "hint",
        timeout: 1800,
        list: false,
    };
    const values = { "--root": "root", "--server": "server", "--fail-on": "failOn", "--timeout": "timeout" };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === "--list") options.list = true;
        else if (flag === "--allow") options.allow.push(argv[(index += 1)]);
        else if (flag in values) options[values[flag]] = argv[(index += 1)];
        else throw new Error(`unknown argument ${flag}`);
    }
    if (!SEVERITIES.includes(options.failOn)) throw new Error(`--fail-on must be one of ${SEVERITIES.join(", ")}`);
    return { ...options, root: resolve(options.root), timeout: Number(options.timeout) };
}

/** Every diagnostic of every report, flattened to one row each. */
export function rowsOf(reports) {
    return reports.flatMap((report) =>
        (report.items ?? []).map((item) => ({
            file: fileURLToPath(report.uri),
            line: item.range.start.line + 1,
            severity: SEVERITIES[(item.severity ?? 1) - 1],
            code: String(item.code ?? ""),
            message: item.message,
        })),
    );
}

/** The rows that fail the gate: at or above `failOn`, in a file no allow-list part names. */
export function violations(rows, allow, failOn) {
    const limit = SEVERITIES.indexOf(failOn);
    return rows.filter(
        (row) =>
            SEVERITIES.indexOf(row.severity) <= limit &&
            !allow.some((part) => row.file.replaceAll("\\", "/").includes(part)),
    );
}

/** `code severity: count`, most frequent first. */
export function summary(rows) {
    const counts = new Map();
    for (const row of rows) {
        const key = `${row.code} ${row.severity}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].sort((left, right) => right[1] - left[1]).map(([key, count]) => `${String(count).padStart(6)}  ${key}`);
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const deadline = Date.now() + options.timeout * 1000;
    const session = await openSession(options.server, options.root, options.timeout);
    const rows = rowsOf(await settledReports(session, deadline));
    await closeSession(session);

    const failing = violations(rows, options.allow, options.failOn);
    console.log(`${rows.length} diagnostics under ${options.root}; ${failing.length} outside the allow-list:`);
    summary(failing).forEach((line) => console.log(line));
    if (options.list) failing.forEach((row) => console.log(`${row.file}:${row.line}: ${row.severity} ${row.code}: ${row.message}`));
    process.exit(failing.length === 0 ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(2);
    });
}
