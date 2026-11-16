#!/usr/bin/env node
// Applies mechanical fixes at the exact ranges the compilers report — never by
// searching source text. It runs the host's own workspace diagnostics over a
// folder, as tools/ci/workspace-diagnostics.mjs does, and for one diagnostic
// code edits each reported range in place. [DIAG-HYGIENE-GUARD]
//
// Fixes:
//   --code FS3886      parenthesise the reported single-tuple list element
//   --code IDE0001     remove the qualifier or type arguments Roslyn marks unnecessary
//   --code IDE0002     the same, for member access
//   --code FL0085      put [<TailCall>] on each reported recursive binding
//   --fix-all <code>   apply the server's own "Fix all in solution" for the first
//                      diagnostic with that code (SLSPF0102, SLSPF0103, IDE0001…)
//   --rename <code>    rename every identifier a naming rule reports (FL0067,
//                      FL0068) to camelCase with the server's own rename
//
// Usage: node tools/debug/fix-diagnostics.mjs (--code FS3886 | --fix-all <code> | --rename <code>)
//          [--root <dir>] [--server <path>] [--under <path-part>] [--dry-run]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SUPERSEDED, closeSession, openSession, settledReports as settled, sleep } from "../ci/lsp-session.mjs";
import { parseArguments } from "../ci/workspace-diagnostics.mjs";

/**
 * FS3886 reports the whole list or array whose one element is a tuple: the fix
 * parenthesises that element inside the brackets. A list that spans lines has
 * its continuation lines pushed one column right, to stay aligned under the
 * element the parenthesis moved; one holding a triple-quoted string is left
 * alone (returned unchanged), because its text may not be re-indented.
 */
export function parenthesiseSoleElement(text) {
    const bracket = text.startsWith("[|") ? 2 : 1;
    const inner = text.slice(bracket, text.length - bracket);
    if (inner.includes("\n") && inner.includes('"""')) return text;
    const lead = inner.length - inner.trimStart().length;
    const body = inner.trim().replaceAll("\n", "\n ");
    const trail = inner.slice(inner.trimEnd().length);
    return `${text.slice(0, bracket)}${inner.slice(0, lead)}(${body})${trail}${text.slice(text.length - bracket)}`;
}

/** What each supported code does to the text of its reported range. */
const FIXES = {
    FS3886: parenthesiseSoleElement,
    // Roslyn marks exactly the unnecessary text: a qualifier or inferable type arguments.
    IDE0001: () => "",
    IDE0002: () => "",
};

/**
 * `[<TailCall>]` for the recursive binding on `line` (FL0085): on its own line above a
 * `let rec`, inline after an `and`. The compiler then proves or refutes the claim (FS3569).
 */
export function withTailCall(line) {
    const indent = line.slice(0, line.length - line.trimStart().length);
    const body = line.trimStart();
    return body.startsWith("and ") ? `${indent}and [<TailCall>] ${body.slice(4)}` : `${indent}[<TailCall>]\n${line}`;
}

/** Fixes that rewrite the whole line a diagnostic starts on. */
const LINE_FIXES = {
    FL0085: withTailCall,
};

/** `text` with `fix` applied to each distinct line the ranges start on. */
export function applyLineFixes(text, ranges, fix) {
    const lines = text.split("\n");
    for (const line of new Set(ranges.map((range) => range.start.line))) {
        lines[line] = fix(lines[line]);
    }
    return lines.join("\n");
}

/** Codes whose range is a qualifier: the dot that follows it goes with it. */
const QUALIFIER_CODES = ["IDE0001", "IDE0002"];

/** `range` extended over a `.` that directly follows it in `text`. */
export function overFollowingDot(text, range) {
    const end = offsetOf(text, range.end);
    return text[end] === "." ? { start: range.start, end: { line: range.end.line, character: range.end.character + 1 } } : range;
}


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

/** `text` with LSP text edits applied, last edit first so offsets stay true. */
export function applyTextEdits(text, edits) {
    const spans = edits
        .map((edit) => [offsetOf(text, edit.range.start), offsetOf(text, edit.range.end), edit.newText])
        .sort((left, right) => right[0] - left[0] || right[1] - left[1]);
    return spans.reduce((fixed, [start, end, newText]) => fixed.slice(0, start) + newText + fixed.slice(end), text);
}

/** The text edits of a workspace edit, by file, whichever shape the server used. */
export function editsByFile(edit) {
    const files = new Map(Object.entries(edit.changes ?? {}).map(([uri, edits]) => [fileURLToPath(uri), edits]));
    for (const change of edit.documentChanges ?? []) {
        if (change.textDocument !== undefined) files.set(fileURLToPath(change.textDocument.uri), change.edits);
    }
    return files;
}

/** The first diagnostic with `code` under `under`, with its document. */
export function firstDiagnostic(reports, code, under) {
    for (const report of reports) {
        const item = (report.items ?? []).find((found) => String(found.code) === code);
        if (item !== undefined && fileURLToPath(report.uri).replaceAll("\\", "/").includes(under)) return { uri: report.uri, item };
    }
    return undefined;
}

/** Ask the server for its solution-wide fix of one diagnostic and return the resolved edit. */
async function solutionFix(session, { uri, item }) {
    const text = readFileSync(fileURLToPath(uri), "utf8");
    const languageId = uri.endsWith(".cs") ? "csharp" : "fsharp";
    session.send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId, version: 1, text } } });
    const params = { textDocument: { uri }, range: item.range, context: { diagnostics: [item] } };
    let actions = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
        actions = (await session.request("textDocument/codeAction", params)).result ?? [];
        const fixAll = actions.find((action) => action.title.startsWith("Fix all in solution: "));
        if (fixAll !== undefined) {
            console.log(fixAll.title);
            const resolved = await session.request("codeAction/resolve", fixAll);
            if (resolved.error !== undefined) throw new Error(JSON.stringify(resolved.error));
            return resolved.result.edit;
        }
        await sleep(2000);
    }
    const offered = actions.map((action) => action.title).join(" | ");
    throw new Error(`no "Fix all in solution" action for ${item.code} at ${uri}; offered: ${offered}`);
}

/** `SCREAMING_SNAKE`, `PascalCase` or `snake_case` as camelCase. */
export function camelCase(name) {
    const shouting = name === name.toUpperCase();
    const words = name.split("_").filter((word) => word.length > 0);
    return words
        .map((word, index) => {
            const body = shouting || words.length > 1 ? word.toLowerCase() : word;
            const first = index === 0 ? body[0].toLowerCase() : body[0].toUpperCase();
            return first + (shouting || words.length > 1 ? body.slice(1) : word.slice(1));
        })
        .join("");
}

/** Rename one reported identifier; the files the server's edit changed, or nothing when it refused. */
async function renameOne(session, { uri, item }, opened) {
    const file = fileURLToPath(uri);
    const text = readFileSync(file, "utf8");
    const oldName = text.slice(offsetOf(text, item.range.start), offsetOf(text, item.range.end));
    const newName = camelCase(oldName);
    if (!opened.has(uri)) {
        opened.set(uri, 1);
        session.send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "fsharp", version: 1, text } } });
    }
    // A rename the compilers supersede is asked again: it is the standard retriable answer.
    let response;
    for (let attempt = 0; attempt < 60; attempt += 1) {
        response = await session.request("textDocument/rename", { textDocument: { uri }, position: item.range.start, newName });
        if (response.error?.code !== SUPERSEDED) break;
        await sleep(1000);
    }
    const edits = response.error === undefined && response.result ? editsByFile(response.result) : new Map();
    console.log(`${oldName} -> ${newName}: ${edits.size === 0 ? `refused ${JSON.stringify(response.error ?? null)}` : `${edits.size} files`}`);
    for (const [changed, fileEdits] of edits) {
        const fixed = applyTextEdits(readFileSync(changed, "utf8"), fileEdits);
        writeFileSync(changed, fixed);
        const changedUri = pathToFileURL(changed).href;
        if (opened.has(changedUri)) {
            opened.set(changedUri, opened.get(changedUri) + 1);
            const textDocument = { uri: changedUri, version: opened.get(changedUri) };
            session.send({ method: "textDocument/didChange", params: { textDocument, contentChanges: [{ text: fixed }] } });
        }
    }
    const changes = [...edits.keys()].map((changed) => ({ uri: pathToFileURL(changed).href, type: 2 }));
    if (changes.length > 0) session.send({ method: "workspace/didChangeWatchedFiles", params: { changes } });
    return edits.size;
}

/** Whether `text` still holds an identifier the rename would change. */
export function needsRename(text) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) && camelCase(text) !== text;
}

/**
 * Rename every identifier `code` reports under `under`, from one settled pull. A
 * rename changes no line count, so later reports keep their place; one whose range
 * no longer holds a name to change — the second report on a name already renamed —
 * is passed over.
 */
async function renameAll(settledReports, session, code, under) {
    const opened = new Map();
    const outcome = { renamed: 0, refused: 0 };
    const reports = await settledReports();
    for (const report of reports) {
        if (!fileURLToPath(report.uri).replaceAll("\\", "/").includes(under)) continue;
        for (const item of (report.items ?? []).filter((found) => String(found.code) === code)) {
            const text = readFileSync(fileURLToPath(report.uri), "utf8");
            if (!needsRename(text.slice(offsetOf(text, item.range.start), offsetOf(text, item.range.end)))) continue;
            if ((await renameOne(session, { uri: report.uri, item }, opened)) === 0) outcome.refused += 1;
            else outcome.renamed += 1;
        }
    }
    return outcome;
}

async function main() {
    const argv = process.argv.slice(2);
    const take = (flag) => {
        const index = argv.indexOf(flag);
        return index < 0 ? undefined : argv.splice(index, 2)[1];
    };
    const fixAllCode = take("--fix-all");
    const renameCode = take("--rename");
    const code = take("--code") ?? fixAllCode ?? renameCode;
    const under = take("--under") ?? "/";
    const dryRun = argv.includes("--dry-run") && argv.splice(argv.indexOf("--dry-run"), 1).length > 0;
    const fix = FIXES[code] ?? LINE_FIXES[code];
    if (fix === undefined && fixAllCode === undefined && renameCode === undefined) throw new Error(`--code must be one of ${Object.keys(FIXES).join(", ")}`);
    const options = parseArguments(argv);

    const session = await openSession(options.server, options.root, options.timeout);
    const deadline = Date.now() + options.timeout * 1000;
    const settledReports = () => settled(session, deadline);
    if (renameCode !== undefined) {
        const outcome = await renameAll(settledReports, session, renameCode, under);
        await closeSession(session);
        console.log(`renamed ${outcome.renamed} identifiers; ${outcome.refused} refused`);
        process.exit(0);
    }
    const reports = await settledReports();
    if (fixAllCode !== undefined) {
        const target = firstDiagnostic(reports, fixAllCode, under);
        if (target === undefined) throw new Error(`no ${fixAllCode} diagnostic under ${under}`);
        const edits = editsByFile(await solutionFix(session, target));
        await closeSession(session);
        let total = 0;
        for (const [file, fileEdits] of edits) {
            total += fileEdits.length;
            console.log(`${file}: ${fileEdits.length}`);
            if (!dryRun) writeFileSync(file, applyTextEdits(readFileSync(file, "utf8"), fileEdits));
        }
        console.log(`${dryRun ? "would apply" : "applied"} ${total} edits in ${edits.size} files`);
        process.exit(0);
    }
    await closeSession(session);

    const files = rangesByFile(reports, code, under);
    let count = 0;
    for (const [file, ranges] of files) {
        const text = readFileSync(file, "utf8");
        count += ranges.length;
        const first = ranges[0];
        const sample = text.slice(offsetOf(text, first.start), offsetOf(text, first.end)).replaceAll("\n", "⏎").slice(0, 80);
        console.log(`${file}: ${ranges.length}  e.g. ${sample}`);
        const spans = QUALIFIER_CODES.includes(code) ? ranges.map((range) => overFollowingDot(text, range)) : ranges;
        const fixed = code in LINE_FIXES ? applyLineFixes(text, ranges, fix) : applyFixes(text, spans, fix);
        if (!dryRun) writeFileSync(file, fixed);
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
