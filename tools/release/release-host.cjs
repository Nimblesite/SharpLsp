// Shared helper: spawns only the downloaded bundle host with both
// bundled engines against an isolated temp fixture. Offers { request, open, change, uri, pid } to tests.
const assert = require("node:assert");
const {
    createMessageConnection,
} = require("../../src/editors/vscode/node_modules/vscode-jsonrpc/lib/node/main.js");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, dirname, resolve, isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");

// Requires absolute bundle path, exact 0.33.0 host.
function requireBundle() {
    const bundle = process.env.SHARPLSP_RELEASE_BUNDLE;
    assert.ok(
        bundle && isAbsolute(bundle),
        "SHARPLSP_RELEASE_BUNDLE must be an absolute directory",
    );
    const bundleDir = resolve(bundle);
    const host = join(bundleDir, "sharplsp");
    const version = execFileSync(host, ["--version"], {
        encoding: "utf8",
        timeout: 30000,
    });
    assert.strictEqual(
        version.trim(),
        "sharplsp 0.33.0",
        `host --version must be 0.33.0, got: ${version.trim()}`,
    );
    return {
        host,
        csharp: join(bundleDir, "sidecar-csharp/SharpLsp.Sidecar.CSharp"),
        fsharp: join(bundleDir, "sidecar-fsharp/SharpLsp.Sidecar.FSharp"),
    };
}

function requireExtensionManifest() {
    const extension = process.env.SHARPLSP_RELEASE_VSIX;
    assert.ok(
        extension && isAbsolute(extension),
        "SHARPLSP_RELEASE_VSIX must identify the extracted official extension",
    );
    const file = join(extension, "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    assert.strictEqual(manifest.publisher, "nimblesite");
    assert.strictEqual(manifest.name, "sharplsp");
    assert.strictEqual(manifest.version, "0.33.0");
    return manifest;
}

async function hoverReady(client, params, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let result;
    do {
        result = await client.request("textDocument/hover", params);
        if (!result?.contents)
            await new Promise((resolve) => setTimeout(resolve, 100));
    } while (!result?.contents && Date.now() < deadline);
    assert.ok(result?.contents, "released semantic hover must be ready");
    return result;
}

// Creates write files, restore+build the entry project (dotnet only).
function buildFixture(prefix, files, entry, expectedCompilerError) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, name)), { recursive: true });
        writeFileSync(join(root, name), text);
    }
    const project = join(root, entry);
    execFileSync("dotnet", ["restore", project, "--disable-parallel"], {
        env: { ...process.env, DOTNET_PROCESSOR_COUNT: "2" },
        stdio: "pipe",
        timeout: 120000,
    });
    const build = spawnSync(
        "dotnet",
        [
            "build",
            project,
            "--no-restore",
            "--disable-build-servers",
            "-p:UseSharedCompilation=false",
        ],
        {
            env: { ...process.env, DOTNET_PROCESSOR_COUNT: "2" },
            encoding: "utf8",
            timeout: 120000,
        },
    );
    assert.strictEqual(
        build.status,
        expectedCompilerError ? 1 : 0,
        build.stdout + build.stderr,
    );
    if (expectedCompilerError)
        assert.ok(
            build.stdout.includes(expectedCompilerError),
            `SDK must prove ${expectedCompilerError}`,
        );
    return root;
}

// Spawns the bundle host + both bundled engines, wires a 90s-bounded request channel,
// and always disposes the child and fixture. Returns { request, open, change, uri, pid }.
async function withReleaseHost(
    {
        prefix,
        files,
        entry,
        prepare,
        expectedCompilerError,
        workspaceFolder,
        capabilities = {},
    },
    run,
) {
    const { host, csharp, fsharp } = requireBundle();
    const root = buildFixture(prefix, files, entry, expectedCompilerError);
    try {
        await prepare?.(root);
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
    const workspace = workspaceFolder ? join(root, workspaceFolder) : root;
    const child = spawn(host, [], {
        cwd: workspace,
        env: {
            ...process.env,
            DOTNET_PROCESSOR_COUNT: "2",
            SHARPLSP_CSHARP_SIDECAR_PATH: csharp,
            SHARPLSP_FSHARP_SIDECAR_PATH: fsharp,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const connection = createMessageConnection(child.stdout, child.stdin);
    child.stderr.resume();
    let timeout;
    const deadline = new Promise((_, reject) => {
        timeout = setTimeout(
            () => reject(new Error("LSP request exceeded 90s")),
            90000,
        );
    });
    const request = (method, params, ...cancellation) =>
        Promise.race([
            connection.sendRequest(method, params, ...cancellation),
            deadline,
        ]);
    const uri = (name) => pathToFileURL(join(root, name)).href;
    const open = (name, languageId, text = files[name]) =>
        connection.sendNotification("textDocument/didOpen", {
            textDocument: {
                uri: uri(name),
                languageId,
                version: 1,
                text,
            },
        });
    const change = (name, version, text) =>
        connection.sendNotification("textDocument/didChange", {
            textDocument: { uri: uri(name), version },
            contentChanges: [{ text }],
        });
    try {
        connection.onRequest("workspace/configuration", (params) =>
            params.items.map(() => null),
        );
        connection.onRequest("window/workDoneProgress/create", () => null);
        connection.listen();
        await request("initialize", {
            processId: process.pid,
            rootUri: pathToFileURL(workspace).href,
            capabilities,
        });
        await connection.sendNotification("initialized", {});
        await run({ request, open, change, uri, pid: child.pid });
    } finally {
        try {
            await request("shutdown", null);
            await connection.sendNotification("exit");
        } catch {
            /* host may already be gone */
        }
        clearTimeout(timeout);
        connection.dispose();
        child.stdin.end();
        if (child.exitCode === null) child.kill("SIGTERM");
        rmSync(root, { recursive: true, force: true });
    }
}

module.exports = {
    withReleaseHost,
    requireBundle,
    requireExtensionManifest,
    hoverReady,
    skipUnlessEnabled: (reason) =>
        process.env.RUN_RELEASE_REGRESSIONS === "1" ? false : reason,
};
