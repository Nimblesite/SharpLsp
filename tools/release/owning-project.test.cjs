// [SHARPLSP-ARCHITECTURE-PROJECTS-CSHARP-OWNING] #517 needs a loaded owner before checking build timestamps.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { statSync, symlinkSync } = require("node:fs");
const { join } = require("node:path");
const { withReleaseHost, skipUnlessEnabled } = require("./release-host.cjs");

const project =
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>';
const source =
    'namespace Lone;\npublic static class Guard {\n/// <summary>Throws when the value is null.</summary>\npublic static T AgainstNull<T>(T? value) where T : class => value ?? throw new System.ArgumentNullException(nameof(value));\npublic static int Count = AgainstNull("x").Length;\n}';

test(
    "#517 symlinked owning project answers and preserves incremental output",
    {
        skip: skipUnlessEnabled(
            "#517 owner hover unavailable in released host probe",
        ),
    },
    async () => {
        let root;
        let before;
        const build = () =>
            execFileSync(
                "dotnet",
                [
                    "build",
                    join(root, "Lone/Lone.csproj"),
                    "--disable-build-servers",
                    "-p:UseSharedCompilation=false",
                ],
                {
                    timeout: 60000,
                    env: { ...process.env, DOTNET_PROCESSOR_COUNT: "2" },
                    stdio: "pipe",
                },
            );
        await withReleaseHost(
            {
                prefix: "sharplsp-517-",
                entry: "HomeOnly.slnx",
                files: {
                    "Directory.Build.props": "<Project />",
                    "Directory.Build.targets": "<Project />",
                    "sharplsp.toml":
                        '[csharp]\nsolution_path = "HomeOnly.slnx"\n',
                    "HomeOnly.slnx":
                        '<Solution><Project Path="Home/Home.csproj" /></Solution>',
                    "Home/Home.csproj": project,
                    "Home/Home.cs": "namespace Home; public class House {}",
                    "Lone/Lone.csproj": project,
                    "Lone/Guard.cs": source,
                },
                prepare: (directory) => {
                    root = directory;
                    build();
                    before = statSync(
                        join(root, "Lone/bin/Debug/net10.0/Lone.dll"),
                    ).mtimeMs;
                    symlinkSync(
                        join(root, "Lone"),
                        join(root, "LoneLink"),
                        "dir",
                    );
                },
            },
            async ({ request, open, uri }) => {
                await open("LoneLink/Guard.cs", "csharp", source);
                const until = Date.now() + 30000;
                let hover;
                do {
                    hover = await request("textDocument/hover", {
                        textDocument: { uri: uri("LoneLink/Guard.cs") },
                        position: { line: 3, character: 19 },
                    });
                    if (hover?.contents?.value.includes("AgainstNull")) break;
                    await new Promise((resolve) => setTimeout(resolve, 500));
                } while (Date.now() < until);
                assert.ok(
                    hover?.contents?.value.includes("AgainstNull"),
                    "owner must answer through the symlink before incremental-build verification",
                );
                build();
                assert.equal(
                    statSync(join(root, "Lone/bin/Debug/net10.0/Lone.dll"))
                        .mtimeMs,
                    before,
                    "owner adoption must preserve the user build output timestamp",
                );
            },
        );
    },
);
