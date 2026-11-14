// Skipped regression for #388: String.Trim XML docs missing in published v0.33.0.
// Run with: RUN_RELEASE_REGRESSIONS=1 SHARPLSP_RELEASE_BUNDLE=/abs/path node tools/release/fsharp-hover-docs.test.cjs
const test = require("node:test");
const assert = require("node:assert");
const { withReleaseHost, skipUnlessEnabled } = require("./release-host.cjs");

const source = `module Probe
let trimmed = " hello ".Trim()
`;

test(
    "#388 F# hover on String.Trim includes XML docs in released v0.33.0 bundle",
    {
        skip: skipUnlessEnabled(
            "#388 String.Trim XML docs missing in published v0.33.0",
        ),
    },
    async () => {
        await withReleaseHost(
            {
                prefix: "sharplsp-388-",
                entry: "Probe.fsproj",
                files: {
                    "Directory.Build.props": "<Project />",
                    "Directory.Build.targets": "<Project />",
                    "Probe.fsproj":
                        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Include="Probe.fs" /></ItemGroup></Project>',
                    "Probe.fs": source,
                },
            },
            async ({ request, open, uri }) => {
                await open("Probe.fs", "fsharp");
                const document = { uri: uri("Probe.fs") };
                const line = source.split("\n")[1];
                const character = line.indexOf("Trim") + 2;
                const hover = await request("textDocument/hover", {
                    textDocument: document,
                    position: { line: 1, character },
                });
                assert.ok(hover, "hover on Trim must be nonnull");
                const contents = JSON.stringify(hover.contents);
                assert.ok(
                    contents.includes("Trim"),
                    `hover must contain signature Trim: ${contents}`,
                );
                assert.ok(
                    contents.includes(
                        "Removes all leading and trailing white-space characters",
                    ),
                    `hover must contain Trim XML doc: ${contents}`,
                );
            },
        );
    },
);
