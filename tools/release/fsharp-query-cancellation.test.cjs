// [DIAG-ANALYSIS-CANCELLATION] #562 Real project-wide FCS work must honor cancellation.
// [SHARPLSP-ARCHITECTURE-ROUTING] #237 Independent requests stay responsive.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const {
    CancellationTokenSource,
} = require("../../src/editors/vscode/node_modules/vscode-jsonrpc/lib/node/main.js");
const { withReleaseHost, skipUnlessEnabled } = require("./release-host.cjs");

const source =
    'module CancellationInput.Library\n\nlet value (x: int): int = "broken"\n';
const files = {
    "Directory.Build.props": "<Project />",
    "Directory.Build.targets": "<Project />",
    ".editorconfig": "root = true\n",
    "sharplsp.toml": "[diagnostics]\nanalyzers_enabled = false\n",
    "Input.fsproj":
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Include="Library.fs" /><Compile Include="Other.fs" /></ItemGroup></Project>',
    "Input.slnx": '<Solution><Project Path="Input.fsproj" /></Solution>',
    "Library.fs": source,
    "Other.fs":
        "module CancellationInput.Other\nlet result = CancellationInput.Library.value 42\n",
};

async function waitFor(check, message) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await delay(20);
    }
    assert.fail(message);
}

function heldCompiler(hostPid, root) {
    const engine = join(
        process.env.SHARPLSP_RELEASE_BUNDLE,
        "sidecar-fsharp/SharpLsp.Sidecar.FSharp",
    );
    const children = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8",
    });
    const compiler = children.split("\n").find((line) => {
        const fields = line.trim().split(/\s+/);
        return fields[1] === String(hostPid) && fields[2] === engine;
    });
    if (!compiler) return false;
    const pid = compiler.trim().split(/\s+/)[0];
    const held = spawnSync(
        "lsof",
        ["-a", "-p", pid, "-Fpcfan", "--", join(root, "Other.fs")],
        { encoding: "utf8", timeout: 3000 },
    );
    return (
        held.status === 0 &&
        held.stdout.includes(`p${pid}\n`) &&
        held.stdout.includes("\nar\n")
    );
}

async function release(root, holder) {
    if (!holder || holder.exitCode !== null) return;
    const closed = new Promise((resolve) => holder.once("close", resolve));
    if (fs.existsSync(root)) fs.writeFileSync(join(root, "release"), "release");
    else holder.kill("SIGTERM");
    await Promise.race([closed, delay(3000)]);
    if (holder.exitCode === null) holder.kill("SIGTERM");
}

const scenarios = [
    ...[
        "textDocument/references",
        "textDocument/implementation",
        "callHierarchy/incomingCalls",
    ].map((method) => ({ issue: 562, method })),
    ...[
        {
            method: "textDocument/hover",
            file: "CSharp/Concurrent.cs",
            position: { line: 1, character: 49 },
            expected: "public static int ConcurrencyInput.Library.Value",
        },
        {
            method: "textDocument/documentSymbol",
            file: "Library.fs",
            expected: '"name":"value"',
        },
        {
            method: "textDocument/documentSymbol",
            file: "CSharp/Concurrent.cs",
            expected: '"name":"Value"',
        },
    ].map((probe) => ({
        issue: 237,
        method: "textDocument/references",
        probe,
    })),
];

for (const { issue, method, probe } of scenarios) {
    test(
        probe
            ? `#237 ${probe.file} ${probe.method} responds while FCS is held`
            : `#562 ${method} cancels while the real FCS project read is held`,
        {
            skip:
                process.platform !== "linux"
                    ? "Linux FCS descriptor proof required"
                    : skipUnlessEnabled(
                          `#${issue} released host blocks behind held FCS work`,
                      ),
        },
        async () => {
            let root;
            let holder;
            try {
                await withReleaseHost(
                    {
                        prefix: `sharplsp-${issue}-`,
                        files: probe
                            ? {
                                  ...files,
                                  "CSharp/Concurrent.csproj":
                                      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
                                  "CSharp/Concurrent.cs":
                                      "namespace ConcurrencyInput;\npublic static class Library { public static int Value => 42; }\n",
                                  "Input.slnx":
                                      '<Solution><Project Path="Input.fsproj" /><Project Path="CSharp/Concurrent.csproj" /></Solution>',
                              }
                            : files,
                        entry: probe ? "Input.slnx" : "Input.fsproj",
                        expectedCompilerError: "FS0001",
                        capabilities: { textDocument: { diagnostic: {} } },
                        prepare: (directory) => {
                            root = directory;
                            const held = join(root, "Other.fs");
                            fs.writeFileSync(
                                join(root, "saved.txt"),
                                files["Other.fs"],
                            );
                            fs.unlinkSync(held);
                            execFileSync("mkfifo", [held]);
                            holder = spawn(
                                "python3",
                                [
                                    join(__dirname, "fixtures/held-source.py"),
                                    held,
                                    join(root, "saved.txt"),
                                    join(root, "opened.json"),
                                    join(root, "release"),
                                    join(root, "released.json"),
                                ],
                                { stdio: "ignore" },
                            );
                        },
                    },
                    async ({ request, open, uri, pid }) => {
                        let pending;
                        const token = new CancellationTokenSource();
                        try {
                            await open("Library.fs", "fsharp");
                            const position = {
                                textDocument: { uri: uri("Library.fs") },
                                position: { line: 2, character: 5 },
                            };
                            await waitFor(async () => {
                                const hover = await request(
                                    "textDocument/hover",
                                    position,
                                );
                                return hover?.contents?.value?.includes(
                                    "val value: x: int -> int",
                                );
                            }, "real FCS hover must resolve the query anchor");
                            if (probe) {
                                await open(
                                    "CSharp/Concurrent.cs",
                                    "csharp",
                                    "namespace ConcurrencyInput;\npublic static class Library { public static int Value => 42; }\n",
                                );
                                const baseline = await request(
                                    "textDocument/hover",
                                    {
                                        textDocument: {
                                            uri: uri("CSharp/Concurrent.cs"),
                                        },
                                        position: { line: 1, character: 49 },
                                    },
                                );
                                assert.ok(
                                    baseline?.contents?.value?.includes(
                                        "public static int ConcurrencyInput.Library.Value",
                                    ),
                                    "independent released Roslyn baseline required",
                                );
                            }
                            const params =
                                method === "callHierarchy/incomingCalls"
                                    ? {
                                          item: (
                                              await request(
                                                  "textDocument/prepareCallHierarchy",
                                                  position,
                                              )
                                          )[0],
                                      }
                                    : {
                                          ...position,
                                          context: { includeDeclaration: true },
                                      };
                            if (method === "callHierarchy/incomingCalls")
                                assert.ok(
                                    params.item,
                                    "real callable anchor required",
                                );
                            let settled = false;
                            pending = request(method, params, token.token)
                                .then(
                                    (result) => ({ result }),
                                    (error) => ({ error }),
                                )
                                .finally(() => {
                                    settled = true;
                                });
                            await waitFor(
                                () =>
                                    fs.existsSync(join(root, "opened.json")) &&
                                    heldCompiler(pid, root),
                                "released FCS must own the native source read",
                            );
                            assert.equal(
                                settled,
                                false,
                                "query must still be active before cancellation",
                            );
                            let response = pending;
                            if (probe) {
                                response = request(probe.method, {
                                    textDocument: { uri: uri(probe.file) },
                                    position: probe.position,
                                }).then(
                                    (result) => ({ result }),
                                    (error) => ({ error }),
                                );
                            } else token.cancel();
                            const terminal = await Promise.race([
                                response,
                                delay(2000).then(() => ({ timeout: true })),
                            ]);
                            assert.equal(
                                fs.existsSync(join(root, "released.json")),
                                false,
                                "old native read must remain held during the cancellation assertion",
                            );
                            if (probe) {
                                assert.notEqual(
                                    terminal.timeout,
                                    true,
                                    `#237 ${probe.file} ${probe.method} must respond before the held FCS read releases`,
                                );
                                assert.ok(
                                    JSON.stringify(terminal.result)?.includes(
                                        probe.expected,
                                    ),
                                    "independent request must return its actual symbol",
                                );
                                assert.equal(
                                    settled,
                                    false,
                                    "slow FCS work must still be active when the independent request answers",
                                );
                            } else {
                                assert.equal(
                                    terminal.error?.code,
                                    -32800,
                                    `#562 ${method} must cancel before the native source read is released; got ${JSON.stringify(terminal)}`,
                                );
                            }
                        } finally {
                            await release(root, holder);
                            if (pending)
                                await Promise.race([pending, delay(3000)]);
                            token.dispose();
                        }
                    },
                );
            } finally {
                await release(root, holder);
            }
        },
    );
}
