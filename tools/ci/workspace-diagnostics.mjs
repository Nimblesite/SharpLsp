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
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Fixtures whose diagnostics are the point of them. */
const DEMO_FIXTURES = ["/diagnostic-lint", "/diagnostic-tags", "/diagnostic-cancellation"];

/** LSP severities, most severe first; the index + 1 is the wire value. */
const SEVERITIES = ["error", "warning", "information", "hint"];

/** The standard "superseded, ask again" error of a diagnostic pull. */
const SUPERSEDED = -32802;

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

/** Split complete `Content-Length` framed messages off the front of `buffer`. */
export function takeMessages(buffer) {
    const messages = [];
    let rest = buffer;
    for (;;) {
        const header = rest.indexOf("\r\n\r\n");
        const length = header < 0 ? undefined : /Content-Length: (\d+)/i.exec(rest.subarray(0, header).toString("ascii"));
        if (!length || rest.length < header + 4 + Number(length[1])) return { messages, rest };
        const end = header + 4 + Number(length[1]);
        messages.push(JSON.parse(rest.subarray(header + 4, end).toString("utf8")));
        rest = rest.subarray(end);
    }
}

/** A JSON-RPC session with a spawned language server over stdio. */
class Session {
    constructor(server, root) {
        this.child = spawn(server, [], { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
        this.buffer = Buffer.alloc(0);
        this.nextId = 1;
        this.pending = new Map();
        this.loaded = new Promise((done) => (this.markLoaded = done));
        this.refreshes = 0;
        this.child.stdout.on("data", (chunk) => this.receive(chunk));
        this.exited = new Promise((done) => this.child.on("exit", done));
    }

    receive(chunk) {
        const { messages, rest } = takeMessages(Buffer.concat([this.buffer, chunk]));
        this.buffer = rest;
        messages.forEach((message) => this.dispatch(message));
    }

    /** Answer the server's requests with nothing, note its signals, settle our requests. */
    dispatch(message) {
        if (message.method === "workspace/projectInitializationComplete") this.markLoaded();
        if (message.method === "workspace/diagnostic/refresh") this.refreshes += 1;
        if (message.method !== undefined && message.id !== undefined) this.send({ id: message.id, result: null });
        if (message.method === undefined) this.pending.get(message.id)?.(message);
    }

    send(body) {
        const text = JSON.stringify({ jsonrpc: "2.0", ...body });
        this.child.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
    }

    request(method, params) {
        const id = this.nextId++;
        return new Promise((done) => {
            this.pending.set(id, done);
            this.send({ id, method, params });
        });
    }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Pull the whole workspace, asking again while the compilers supersede the pull. */
async function pull(session, deadline) {
    for (;;) {
        const response = await session.request("workspace/diagnostic", { previousResultIds: [] });
        if (response.error === undefined) return response.result.items;
        if (response.error.code !== SUPERSEDED || Date.now() > deadline) {
            throw new Error(`workspace/diagnostic failed: ${JSON.stringify(response.error)}`);
        }
        await sleep(500);
    }
}

/** Pull until two pulls in a row agree and the server asked for no refresh between them. */
async function settledReports(session, deadline) {
    let previous;
    for (;;) {
        const refreshes = session.refreshes;
        const items = await pull(session, deadline);
        const snapshot = JSON.stringify(items);
        if (snapshot === previous && refreshes === session.refreshes) return items;
        if (Date.now() > deadline) throw new Error("workspace diagnostics never settled");
        previous = snapshot;
        await sleep(2000);
    }
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
    const session = new Session(options.server, options.root);
    const capabilities = { textDocument: { diagnostic: {} }, workspace: { diagnostics: { refreshSupport: true } } };
    await session.request("initialize", { processId: process.pid, rootUri: pathToFileURL(options.root).href, capabilities });
    session.send({ method: "initialized", params: {} });
    await Promise.race([session.loaded, sleep(options.timeout * 1000)]);
    const rows = rowsOf(await settledReports(session, deadline));
    await session.request("shutdown", null);
    session.send({ method: "exit" });
    await Promise.race([session.exited, sleep(10_000)]);

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
