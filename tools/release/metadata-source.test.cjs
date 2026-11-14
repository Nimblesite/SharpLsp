// [DEFINITION-CSHARP-METADATA] #391 Metadata-as-source must render the available runtime implementation.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { fileURLToPath } = require("node:url");
const { withReleaseHost, skipUnlessEnabled } = require("./release-host.cjs");

const source =
    "namespace Probe; public class Widget { public string Json => System.Text.Json.JsonSerializer.Serialize(1); }\n";
test(
    "#391 JsonSerializer metadata source has actual implementation bodies",
    {
        skip: skipUnlessEnabled(
            "#391 reference-assembly stubs still decompiled",
        ),
    },
    async () => {
        await withReleaseHost(
            {
                prefix: "sharplsp-391-",
                entry: "Probe.csproj",
                files: {
                    "Probe.csproj":
                        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
                    "Widget.cs": source,
                },
            },
            async ({ request, open, uri }) => {
                await open("Widget.cs", "csharp");
                const position = {
                    line: 0,
                    character: source.indexOf("JsonSerializer") + 2,
                };
                const definition = await request("textDocument/definition", {
                    textDocument: { uri: uri("Widget.cs") },
                    position,
                });
                assert.equal(definition.length, 1);
                const decompiled = fileURLToPath(definition[0].uri);
                const artifacts = mkdtempSync(
                    join(tmpdir(), "sharplsp-metadata-oracle-"),
                );
                try {
                    const project = join(
                        __dirname,
                        "oracles/MetadataBody.csproj",
                    );
                    execFileSync(
                        "dotnet",
                        [
                            "build",
                            project,
                            "--artifacts-path",
                            artifacts,
                            "--disable-build-servers",
                            `-p:SharpLspReleaseBundle=${process.env.SHARPLSP_RELEASE_BUNDLE}`,
                            "-p:ImportDirectoryBuildProps=false",
                            "-p:ImportDirectoryBuildTargets=false",
                            "-p:UseSharedCompilation=false",
                        ],
                        {
                            stdio: "pipe",
                            timeout: 60000,
                            env: {
                                ...process.env,
                                DOTNET_PROCESSOR_COUNT: "2",
                            },
                        },
                    );
                    const oracle = JSON.parse(
                        execFileSync(
                            "dotnet",
                            [
                                join(
                                    artifacts,
                                    "bin/MetadataBody/debug/MetadataBody.dll",
                                ),
                                decompiled,
                            ],
                            { encoding: "utf8", timeout: 15000 },
                        ),
                    );
                    assert.equal(
                        oracle.RuntimeAssemblyExists,
                        true,
                        "runtime implementation assembly is installed",
                    );
                    assert.ok(
                        oracle.Total > 0,
                        "Roslyn parses Serialize methods in returned decompiled source",
                    );
                    assert.ok(
                        oracle.Implementations > 0,
                        `runtime implementation required, AST oracle returned ${JSON.stringify(oracle)}`,
                    );
                } finally {
                    rmSync(artifacts, { recursive: true, force: true });
                }
            },
        );
    },
);
