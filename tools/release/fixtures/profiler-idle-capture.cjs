// #530 released editor journey. Implements [PROF-MEMORY-STOP].
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join, resolve } = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { createRequire } = require("node:module");
const { publishedExtension } = require("./release-editor.cjs");
const rows = [],
    wire = [];
const vscode = () => require("vscode");
const ui = (name) =>
    vscode().commands.executeCommand(`sharplsp.profiler.${name}`);
const pause = (milliseconds) =>
    new Promise((done) => setTimeout(done, milliseconds));
exports.files = {
    "Directory.Build.props": "<Project/>",
    "Directory.Build.targets": "<Project/>",
    "Input.slnx": '<Solution><Project Path="Input.fsproj"/></Solution>',
    "Input.fsproj":
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup><ItemGroup><Compile Include="Program.fs"/></ItemGroup></Project>',
    "Program.fs":
        'open System\nlet held = ResizeArray<byte[]>()\nprintfn "READY"\nlet rec loop () =\n    match Console.ReadLine() with\n    | null -> System.Threading.Thread.Sleep(100); loop ()\n    | "exit" -> ()\n    | _ ->\n        for _ in 1 .. 64 do held.Add(Array.zeroCreate<byte> 32768)\n        printfn "OK %d" held.Count\n        loop ()\nloop ()\n',
};
async function poll(action, accept, label, milliseconds = 15000) {
    const until = Date.now() + milliseconds;
    do {
        const value = await action();
        if (accept(value)) return value;
        await pause(100);
    } while (Date.now() < until);
    throw new Error(label);
}
async function bounded(operation, milliseconds, label) {
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
    });
    try {
        return await Promise.race([operation, deadline]);
    } finally {
        clearTimeout(timer);
    }
}
function save(root) {
    fs.writeFileSync(
        join(root, "release-result.json"),
        JSON.stringify({ rows, wire }, null, 2),
    );
}
function requestRecord(method, params) {
    const label = typeof method === "string" ? method : method.method;
    if (
        label !== "workspace/executeCommand" ||
        !params?.command?.includes(".memory.")
    )
        return undefined;
    const row = {
        command: params.command,
        arguments: params.arguments,
        started: Date.now(),
    };
    wire.push(row);
    return row;
}
function recordResult(row, result) {
    if (!row) return;
    row.finished = Date.now();
    row.outcome = result?.result?.outcome?.kind;
    row.snapshot = result?.result?.outcome?.snapshot?.snapshot_id;
    row.bytes = result?.result?.outcome?.snapshot?.current_bytes;
}
async function forwardRequest(client, original, method, args, root) {
    const row = requestRecord(method, args[0]);
    try {
        const result = await original.call(client, method, ...args);
        recordResult(row, result);
        return result;
    } catch (error) {
        if (row) {
            row.error = String(error);
            row.code = error.code;
        }
        throw error;
    } finally {
        save(root);
    }
}
function observe(client, root) {
    const original = client.sendRequest;
    client.sendRequest = function (method, ...args) {
        return forwardRequest(this, original, method, args, root);
    };
    return () => {
        client.sendRequest = original;
    };
}
async function ready(api) {
    await poll(
        () => api.getLspClient(),
        Boolean,
        "published client did not start",
        120000,
    );
    assert.ok(api.profiler?.ui.store);
    await poll(
        () => api.profiler.ui.store.capabilities.value,
        Boolean,
        "profiler capabilities absent",
    );
}
async function activate(root) {
    const extension = publishedExtension();
    await vscode().window.showTextDocument(
        await vscode().workspace.openTextDocument(join(root, "Program.fs")),
    );
    const api = await extension.activate();
    await ready(api);
    return api;
}
function targetEnvironment() {
    return {
        PATH: process.env.PATH,
        DOTNET_ROOT: process.env.DOTNET_ROOT,
        TMPDIR: process.env.TMPDIR,
        DOTNET_EnableDiagnostics: "1",
        DOTNET_PROCESSOR_COUNT: "2",
    };
}
function targetProcess(root) {
    return spawn(
        join(process.env.DOTNET_ROOT, "dotnet"),
        [join(root, "bin/Debug/net10.0/Input.dll")],
        { cwd: root, env: targetEnvironment() },
    );
}
async function target(root) {
    const child = targetProcess(root);
    const closed = once(child, "close");
    let output = "";
    child.stdout.on("data", (chunk) => {
        output += chunk;
    });
    child.stderr.resume();
    try {
        await poll(
            () => output,
            (value) => value.includes("READY"),
            "F# target did not start",
        );
    } catch (error) {
        await disposeTarget({ child, closed });
        throw error;
    }
    return { child, closed };
}
function configuration() {
    return vscode().workspace.getConfiguration("sharplsp.profiler");
}
function setting(name, value) {
    return configuration().update(
        name,
        value,
        vscode().ConfigurationTarget.Workspace,
    );
}
async function start(store, pid) {
    await setting("autoSnapshot", true);
    await setting("autoSnapshotInterval", 1);
    await vscode().commands.executeCommand(
        "sharplsp.profiler.memoryStart",
        pid,
    );
    await poll(
        () => store.profiler.value.memory,
        (value) => value === "active",
        "memory did not start",
    );
    return store.profiler.value.memorySessionId;
}
function state(pid) {
    return execFileSync("/bin/ps", ["-o", "state=", "-p", String(pid)], {
        encoding: "utf8",
    }).trim();
}
function captureRunning(pid) {
    return execFileSync("/bin/ps", ["-axo", "command"], { encoding: "utf8" })
        .split("\n")
        .some((line) =>
            line.includes("/lsp-profiler-dotnet-engine snapshot --pid " + pid),
        );
}
function resumeWatchdog(pid) {
    return spawn(
        "/usr/bin/python3",
        [
            "-c",
            "import os,signal,time,sys; time.sleep(20); os.kill(int(sys.argv[1]),signal.SIGCONT)",
            String(pid),
        ],
        { stdio: "ignore" },
    );
}
function pendingCapture(id) {
    return wire.find(
        (row) =>
            row.arguments[0]?.memory_session_id === id &&
            row.command.endsWith(".snapshot") &&
            !row.finished &&
            !row.error,
    );
}
function assertStopped(store, owned, watchdog, pending) {
    assert.ok(pending.error);
    assert.ok(state(owned.child.pid).includes("T"));
    assert.equal(watchdog.exitCode, null);
    assert.equal(watchdog.signalCode, null);
    assert.equal(store.profiler.value.memory, "idle");
}
async function heldCapture(id, pid) {
    const pending = await poll(
        () => pendingCapture(id),
        Boolean,
        "automatic capture did not start",
        10000,
    );
    await poll(
        () => captureRunning(pid),
        Boolean,
        "published capture engine absent",
        5000,
    );
    return pending;
}
async function stopFrozen(store, owned, watchdog, id, root) {
    const pending = await heldCapture(id, owned.child.pid);
    const began = Date.now();
    await bounded(ui("memoryStop"), 5000, "stop did not release held capture");
    assertStopped(store, owned, watchdog, pending);
    rows.push({
        stoppedSession: id,
        stopMilliseconds: Date.now() - began,
        targetStillFrozen: true,
    });
    save(root);
}
async function stoppedCapture(store, owned, root) {
    const id = await start(store, owned.child.pid);
    owned.child.kill("SIGSTOP");
    const watchdog = resumeWatchdog(owned.child.pid);
    const closed = once(watchdog, "close");
    try {
        await stopFrozen(store, owned, watchdog, id, root);
    } finally {
        owned.child.kill("SIGCONT");
        watchdog.kill("SIGTERM");
        await closed;
    }
}
function completedSnapshots(id) {
    return wire.filter(
        (row) =>
            row.arguments[0]?.memory_session_id === id &&
            row.outcome === "Snapshot",
    );
}
function recordSnapshots(id, growing, snapshots, root) {
    assert.equal(
        new Set(snapshots.map((row) => row.snapshot)).size,
        snapshots.length,
    );
    assert.ok(snapshots.every((row) => row.bytes > 0));
    rows.push({
        session: id,
        growing,
        snapshots: snapshots.map((row) => row.snapshot),
    });
    save(root);
}
function waitForSnapshots(id, growing) {
    const label = `${growing ? "active control" : "idle session"} did not complete two captures within40s`;
    return poll(
        () => completedSnapshots(id),
        (value) => value.length >= 2,
        label,
        40000,
    );
}
async function captures(store, owned, root, growing) {
    const id = await start(store, owned.child.pid);
    const pulse = growing
        ? setInterval(() => {
              owned.child.stdin.write("grow\n");
          }, 1500)
        : undefined;
    try {
        recordSnapshots(id, growing, await waitForSnapshots(id, growing), root);
    } finally {
        clearInterval(pulse);
        await bounded(ui("memoryStop"), 5000, "capture session did not stop");
    }
}
function silence(extension) {
    const published = createRequire(
        resolve(extension.extensionPath, extension.packageJSON.main),
    )("vscode");
    const originals = {};
    for (const method of [
        "showInformationMessage",
        "showWarningMessage",
        "showErrorMessage",
    ]) {
        originals[method] = published.window[method];
        published.window[method] = async () => undefined;
    }
    return () => {
        for (const [method, original] of Object.entries(originals))
            published.window[method] = original;
    };
}
async function journey(api, owned, root) {
    const store = api.profiler.ui.store;
    await stoppedCapture(store, owned, root);
    let idleError;
    try {
        await captures(store, owned, root, false);
    } catch (error) {
        idleError = error;
        rows.push({ idleFailure: String(error) });
        save(root);
    }
    await captures(store, owned, root, true);
    if (idleError) throw idleError;
}
async function disposeTarget(owned) {
    if (owned.child.exitCode === null && owned.child.signalCode === null) {
        owned.child.kill("SIGCONT");
        owned.child.kill("SIGTERM");
    }
    await owned.closed;
}
async function cleanup(api, owned) {
    if (api.profiler.ui.store.profiler.value.memory !== "idle") {
        await bounded(ui("memoryStop"), 5000, "cleanup stop failed").catch(
            () => {},
        );
    }
    if (owned) await disposeTarget(owned);
}
async function runOwned(api, root) {
    const restore = observe(api.getLspClient(), root);
    const unsilence = silence(publishedExtension());
    let owned;
    try {
        owned = await target(root);
        await journey(api, owned, root);
        rows.push({ passed: true });
    } finally {
        await cleanup(api, owned);
        restore();
        unsilence();
    }
}
exports.run = async () => {
    const root = vscode().workspace.workspaceFolders[0].uri.fsPath;
    try {
        await runOwned(await activate(root), root);
    } catch (error) {
        rows.push({ failed: String(error), stack: error.stack });
        save(root);
        throw error;
    } finally {
        save(root);
    }
};
