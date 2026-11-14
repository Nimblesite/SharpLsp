// [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-OPEN] #221 Completion budget after real edits.
const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fileSystem = require("node:fs");
const path = require("node:path");
const { withReleaseHost, skipUnlessEnabled } = require("./release-host.cjs");

const prefixSource = (prefix, revision) =>
    `module Completing\n\nlet total = List.sum [ 1; 2 ]\nlet builder = ${prefix}()\n// revision ${revision}\n`;

test(
    "#221 F# unopened completion meets p50/p95 budgets after project entity updates and fresh editor changes",
    {
        skip: skipUnlessEnabled(
            "#221 published fresh-edit completion exceeds latency budget",
        ),
    },
    async (context) => {
        let root;
        await withReleaseHost(
            {
                prefix: "sharplsp-221-",
                entry: "Input.fsproj",
                capabilities: { textDocument: { diagnostic: {} } },
                prepare: (directory) => {
                    root = directory;
                },
                files: {
                    "Directory.Build.props": "<Project />",
                    "Directory.Build.targets": "<Project />",
                    ".editorconfig": "root = true\n",
                    "sharplsp.toml":
                        "[csharp]\nenabled = false\n[diagnostics]\nanalyzers_enabled = false\n",
                    "Input.fsproj":
                        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Include="Geometry.fs" /><Compile Include="Completing.fs" /></ItemGroup></Project>',
                    "Geometry.fs":
                        "namespace Geometry\n\ntype Circle = { Radius: float }\n",
                    "Completing.fs":
                        "module Completing\n\nlet total = List.sum [ 1; 2 ]\nlet builder = System.Text.StringBuilder()\n",
                },
            },
            async ({ request, open, change, uri }) => {
                await open(
                    "Completing.fs",
                    "fsharp",
                    prefixSource("StringBu", -1),
                );
                const complete = async (prefix) => {
                    const started = performance.now();
                    const response = await request("textDocument/completion", {
                        textDocument: { uri: uri("Completing.fs") },
                        position: { line: 3, character: 14 + prefix.length },
                    });
                    return {
                        elapsed: performance.now() - started,
                        items: Array.isArray(response)
                            ? response
                            : (response?.items ?? []),
                    };
                };
                const hasBuilder = (reply) =>
                    reply.items.some(
                        (item) =>
                            item.label === "StringBuilder" &&
                            item.detail === "(open System.Text)",
                    );
                const deadline = Date.now() + 30000;
                let ready;
                do {
                    ready = await complete("StringBu");
                    if (hasBuilder(ready)) break;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                } while (Date.now() < deadline);
                assert.ok(
                    hasBuilder(ready),
                    "genuine unopened type must resolve before timing",
                );
                fileSystem.writeFileSync(
                    path.join(root, "Geometry.fs"),
                    "namespace Geometry\n\ntype Circle = { Radius: float }\n\nnamespace Extras\n\ntype StringBuA = class end\n",
                );
                childProcess.execFileSync(
                    "dotnet",
                    [
                        "build",
                        path.join(root, "Input.fsproj"),
                        "--no-restore",
                        "--disable-build-servers",
                        "-p:UseSharedCompilation=false",
                    ],
                    {
                        cwd: root,
                        env: { ...process.env, DOTNET_PROCESSOR_COUNT: "2" },
                        stdio: "pipe",
                        timeout: 60000,
                    },
                );
                const changedUntil = Date.now() + 20000;
                let changed;
                do {
                    changed = await complete("StringBu");
                    if (
                        changed.items.some((item) => item.label === "StringBuA")
                    )
                        break;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                } while (Date.now() < changedUntil);
                assert.ok(
                    changed.items.some((item) => item.label === "StringBuA"),
                    "real project entity update must be visible before timing",
                );
                const prefixes = [
                    "StringB",
                    "StringBu",
                    "StringBui",
                    "StringBuil",
                    "StringBuild",
                    "StringBuilde",
                ];
                const samples = [];
                for (let index = 0; index < 106; index++) {
                    const prefix = prefixes[index % prefixes.length];
                    await change(
                        "Completing.fs",
                        index + 2,
                        prefixSource(prefix, index),
                    );
                    const reply = await complete(prefix);
                    assert.ok(
                        hasBuilder(reply),
                        "each fresh source must retain the actual completion",
                    );
                    if (index >= 5) samples.push(reply.elapsed);
                }
                samples.sort((left, right) => left - right);
                const report = {
                    samples: samples.length,
                    p50: samples[50],
                    p95: samples[95],
                };
                context.diagnostic(JSON.stringify(report));
                assert.ok(
                    report.p50 < 100,
                    `#221 p50 must be below 100ms, got ${report.p50}ms`,
                );
                assert.ok(
                    report.p95 < 200,
                    `#221 p95 must be below 200ms, got ${report.p95}ms`,
                );
            },
        );
    },
);
