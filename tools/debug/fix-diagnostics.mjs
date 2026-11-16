#!/usr/bin/env node
// Applies mechanical fixes at the exact ranges the compilers report — never by
// searching source text. It runs the host's own workspace diagnostics over a
// folder, as tools/ci/workspace-diagnostics.mjs does, and for one diagnostic
// code edits each reported range in place. [DIAG-HYGIENE-GUARD]
//
// Fixes:
//   FS3886  wrap the reported single-tuple list element in parentheses
//
// Usage: node tools/debug/fix-diagnostics.mjs --code FS3886 [--root <dir>]
//          [--server <path>] [--under <path-part>] [--dry-run]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Session } from "../ci/lsp-session.mjs";
import { parseArguments } from "../ci/workspace-diagnostics.mjs";

/** What each supported code does to the text of its reported range. */
const FIXES = {
    FS3886: (text) => `(${text})`,
};

const SUPERSEDED = -32802;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The UTF-16 offset of an LSP position in `text`. */
export function offsetOf(text, position) {
    let offset = 0;
    for (let line = 0; line < position.line; line += 1) {
        offset = text.indexOf("\n", offset) + 1;
    }
    return offset + position.character;
}

/** `text` with `fix` applied to every range, last range first so offsets stay true. */
export function applyFixes(text, ranges, fix) {
    const spans = ranges
        .map((range) => [offsetOf(text, range.start), offsetOf(text, range.end)])
        .sort((left, right) => right[0] - left[0]);
    return spans.reduce((fixed, [start, end]) => fixed.slice(0, start) + fix(fixed.slice(start, end)) + fixed.slice(end), text);
}

/** The reported ranges of `code`, by file, under `under`. */
export function rangesByFile(reports, code, under) {
    const files = new Map();
    for (const report of reports) {
        const file = fileURLToPath(report.uri);
        const ranges = (report.items ?? []).filter((item) => String(item.code) === code).map((item) => item.range);
        if (ranges.length > 0 && file.replaceAll("\\", "/").includes(under)) files.set(file, ranges);
    }
    return files;
}

async function pull(session) {
    for (;;) {
        const response = await session.request("workspace/diagnostic", { previousResultIds: [] });
        if (response.error === undefined) return response.result.items;
        if (response.error.code !== SUPERSEDED) throw new Error(JSON.stringify(response.error));
        await sleep(500);
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const take = (flag) => {
        const index = argv.indexOf(flag);
        return index < 0 ? undefined : argv.splice(index, 2)[1];
    };
    const code = take("--code");
    const under = take("--under") ?? "/";
    const dryRun = argv.includes("--dry-run") && argv.splice(argv.indexOf("--dry-run"), 1).length > 0;
    const fix = FIXES[code];
    if (fix === undefined) throw new Error(`--code must be one of ${Object.keys(FIXES).join(", ")}`);
    const options = parseArguments(argv);

    const session = new Session(options.server, options.root);
    const capabilities = { textDocument: { diagnostic: {} }, workspace: { diagnostics: { refreshSupport: true } } };
    await session.request("initialize", { processId: process.pid, rootUri: pathToFileURL(options.root).href, capabilities });
    session.send({ method: "initialized", params: {} });
    await Promise.race([session.loaded, sleep(options.timeout * 1000)]);
    let previous;
    let reports = await pull(session);
    while (JSON.stringify(reports) !== previous) {
        previous = JSON.stringify(reports);
        await sleep(3000);
        reports = await pull(session);
    }
    await session.request("shutdown", null);
    session.send({ method: "exit" });

    const files = rangesByFile(reports, code, under);
    let count = 0;
    for (const [file, ranges] of files) {
        const text = readFileSync(file, "utf8");
        count += ranges.length;
        console.log(`${file}: ${ranges.length}`);
        if (!dryRun) writeFileSync(file, applyFixes(text, ranges, fix));
    }
    console.log(`${dryRun ? "would fix" : "fixed"} ${count} ${code} in ${files.size} files`);
    process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(2);
    });
}
