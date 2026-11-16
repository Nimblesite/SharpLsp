// A minimal LSP client over stdio for the repository's own tools: it frames
// JSON-RPC, answers the server's requests with nothing, and notes the two
// signals a diagnostics run waits on. [DIAG-HYGIENE-GUARD]
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The standard "superseded, ask again" error of a request the compilers retired. */
export const SUPERSEDED = -32802;

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
export class Session {
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

/** Start the server on `root`, initialize as an editor does, and wait for every project to load. */
export async function openSession(server, root, timeoutSeconds) {
    const session = new Session(server, root);
    const capabilities = { textDocument: { diagnostic: {} }, workspace: { diagnostics: { refreshSupport: true } } };
    await session.request("initialize", { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities });
    session.send({ method: "initialized", params: {} });
    await Promise.race([session.loaded, sleep(timeoutSeconds * 1000)]);
    return session;
}

/** Shut the server down and wait for it to exit. */
export async function closeSession(session) {
    await session.request("shutdown", null);
    session.send({ method: "exit" });
    await Promise.race([session.exited, sleep(10_000)]);
}

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
export async function settledReports(session, deadline) {
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
