// [DIAG-TRUTH-GUARANTEES] #470 Cold compiler analysis must permit retriggering.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { withReleaseHost, skipUnlessEnabled } = require("./release-host.cjs");

for (const target of ["fsharp", "csharp"]) {
    test(
        `#470 cold ${target} diagnostics request permits retriggering`,
        {
            skip: skipUnlessEnabled(
                `#470 ${target} returns retriggerRequest false`,
            ),
        },
        async () => {
            const selected = target === "fsharp" ? "csharp" : "fsharp";
            const files = {};
            const fixture = (folder, language) => {
                const fs = language === "fsharp";
                const entry = fs ? "Entry.fs" : "Entry.cs";
                const closed = fs ? "Closed.fs" : "Closed.cs";
                const project = fs ? "Fs.fsproj" : "Cs.csproj";
                files[`${folder}/Directory.Build.props`] = "<Project />";
                files[`${folder}/Directory.Build.targets`] = "<Project />";
                files[`${folder}/.editorconfig`] = "root = true\n";
                files[`${folder}/sharplsp.toml`] =
                    "[diagnostics]\nanalyzers_enabled = false\n";
                files[`${folder}/${project}`] =
                    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>' +
                    (fs
                        ? '<ItemGroup><Compile Include="Entry.fs" /><Compile Include="Closed.fs" /></ItemGroup>'
                        : "") +
                    "</Project>";
                files[`${folder}/${entry}`] = fs
                    ? "module Cold.Entry\nlet value = 1\n"
                    : "namespace Cold; public static class Entry { public static int Value => 1; }\n";
                files[`${folder}/${closed}`] = fs
                    ? 'module Cold.Closed\nlet answer: int = "wrong"\n'
                    : 'namespace Cold; public static class Closed { public static int Answer => "wrong"; }\n';
                return {
                    entry: `${folder}/${entry}`,
                    closed: `${folder}/${closed}`,
                    project: `${folder}/${project}`,
                    code: fs ? "FS0001" : "CS0029",
                };
            };
            const home = fixture("Selected", selected);
            const external = fixture("External", target);
            await withReleaseHost(
                {
                    prefix: `sharplsp-470-${target}-`,
                    files,
                    entry: home.project,
                    expectedCompilerError: home.code,
                    workspaceFolder: "Selected",
                    prepare: (root) => {
                        const sdk = spawnSync(
                            "dotnet",
                            [
                                "build",
                                join(root, external.project),
                                "--disable-build-servers",
                                "-p:UseSharedCompilation=false",
                            ],
                            {
                                encoding: "utf8",
                                timeout: 60000,
                                env: {
                                    ...process.env,
                                    DOTNET_PROCESSOR_COUNT: "2",
                                },
                            },
                        );
                        assert.equal(sdk.status, 1);
                        assert.ok(sdk.stdout.includes(external.code));
                    },
                },
                async ({ request, open, uri }) => {
                    await open(home.entry, selected);
                    const deadline = Date.now() + 20000;
                    let baseline;
                    do {
                        try {
                            baseline = await request(
                                "textDocument/diagnostic",
                                { textDocument: { uri: uri(home.closed) } },
                            );
                        } catch {
                            baseline = null;
                        }
                        if (
                            baseline?.items?.some(
                                (item) => item.code === home.code,
                            )
                        )
                            break;
                        await new Promise((resolve) =>
                            setTimeout(resolve, 500),
                        );
                    } while (Date.now() < deadline);
                    assert.ok(
                        baseline?.items?.some(
                            (item) => item.code === home.code,
                        ),
                        "selected solution has its SDK-proven error",
                    );
                    const result = await request("textDocument/diagnostic", {
                        textDocument: { uri: uri(external.closed) },
                    }).then(
                        (report) => ({ report }),
                        (error) => ({ error }),
                    );
                    if (result.error) {
                        assert.equal(result.error.code, -32802);
                        assert.equal(
                            result.error.data?.retriggerRequest,
                            true,
                            "cold analysis must request a retry",
                        );
                    } else {
                        assert.ok(
                            result.report.items.some(
                                (item) => item.code === external.code,
                            ),
                            "successful cold analysis must return the SDK-proven compiler error",
                        );
                    }
                },
            );
        },
    );
}
