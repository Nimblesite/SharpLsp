// #564 Default logging must omit idle health checks. [SHARPLSP-PLAN-PROTOCOL]
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const {
    withReleaseHost,
    skipUnlessEnabled,
    hoverReady,
} = require("./release-host.cjs");
const pause = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
const files = {
    "Directory.Build.props": "<Project />",
    "Directory.Build.targets": "<Project />",
    ".editorconfig": "root = true\n",
    "Input.slnx":
        '<Solution><Project Path="CSharp/CSharp.csproj" /><Project Path="FSharp/FSharp.fsproj" /></Solution>',
    "CSharp/CSharp.csproj":
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
    "CSharp/Library.cs":
        "namespace QuietProbe;\npublic static class Library { public static int Value => 42; }\n",
    "FSharp/FSharp.fsproj":
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Include="Library.fs" /></ItemGroup></Project>',
    "FSharp/Library.fs": "module QuietProbe\nlet value = 42\n",
};

function logFiles(directory) {
    const root = join(directory, "sharplsp-logs");
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.includes(".log"))
        .map((entry) => join(root, entry.name));
}

async function warmCompilers(client) {
    for (const [name, language, character] of [
        ["FSharp/Library.fs", "fsharp", 6],
        ["CSharp/Library.cs", "csharp", 21],
    ]) {
        await client.open(name, language);
        await hoverReady(client, {
            textDocument: { uri: client.uri(name) },
            position: { line: 1, character },
        });
    }
    await pause(3000);
}

function readSince(directory, before) {
    return logFiles(directory).map((file) => ({
        file,
        text: fs
            .readFileSync(file)
            .subarray(before.get(file) ?? 0)
            .toString("utf8"),
    }));
}

function assertQuietIdle(context, delta, idleMs) {
    const lines = delta.flatMap((log) => log.text.split("\n").filter(Boolean));
    const pings = lines.filter((line) => /\bping\b/i.test(line));
    const counts = { idleMs, idleLines: lines.length, pingLines: pings.length };
    context.diagnostic(JSON.stringify({ ...counts, delta }));
    assert.equal(
        pings.length,
        0,
        "default idle logs must omit health-check pings",
    );
}

async function observeIdle(directory, client, context) {
    await warmCompilers(client);
    const before = new Map(
        logFiles(directory).map((file) => [file, fs.statSync(file).size]),
    );
    assert.ok(before.size, "released engines must write actual log files");
    const started = Date.now();
    await pause(30000);
    assertQuietIdle(
        context,
        readSince(directory, before),
        Date.now() - started,
    );
}

function restoreEnvironment(saved) {
    for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
}

async function runIdleTest(context) {
    const directory = fs.mkdtempSync(join(tmpdir(), "slsp-idle-"));
    const saved = {
        TMPDIR: process.env.TMPDIR,
        RUST_LOG: process.env.RUST_LOG,
    };
    process.env.TMPDIR = directory;
    delete process.env.RUST_LOG;
    try {
        await withReleaseHost(
            { prefix: "fixture-", files, entry: "Input.slnx" },
            (client) => observeIdle(directory, client, context),
        );
    } finally {
        restoreEnvironment(saved);
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test(
    "#564 published engines omit default idle health-check logs",
    {
        timeout: 120000,
        skip: skipUnlessEnabled(
            "#564 v0.33.0 logs idle health-check pings at its default level",
        ),
    },
    runIdleTest,
);
