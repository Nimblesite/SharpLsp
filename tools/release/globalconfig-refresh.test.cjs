// [DIAG-LSP-REFRESH] #238 A new globalconfig must update the running compiler workspace.
const test = require("node:test");
const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { withReleaseHost, skipUnlessEnabled } = require("./release-host.cjs");

test(
    "#238 new globalconfig changes live compiler diagnostic severity",
    {
        skip: skipUnlessEnabled(
            "#238 newly created globalconfig is not applied live",
        ),
    },
    async () => {
        let root;
        const source =
            "namespace Probe;\npublic static class Widget { public static void Run() { int unused = 42; } }\n";
        await withReleaseHost(
            {
                prefix: "sharplsp-238-",
                entry: "Probe.csproj",
                prepare: (directory) => {
                    root = directory;
                },
                files: {
                    ".editorconfig": "root = true\n",
                    "Probe.csproj":
                        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
                    "Widget.cs": source,
                },
            },
            async ({ request, open, uri }) => {
                await open("Widget.cs", "csharp");
                const document = { uri: uri("Widget.cs") };
                const pull = async () => {
                    try {
                        return await request("textDocument/diagnostic", {
                            textDocument: document,
                        });
                    } catch {
                        return null;
                    }
                };
                const waitForSeverity = async (severity, milliseconds) => {
                    const until = Date.now() + milliseconds;
                    let report;
                    do {
                        report = await pull();
                        if (
                            report?.items?.some(
                                (item) =>
                                    item.code === "CS0219" &&
                                    item.severity === severity,
                            )
                        )
                            return report;
                        await new Promise((resolve) =>
                            setTimeout(resolve, 500),
                        );
                    } while (Date.now() < until);
                    return report;
                };
                let report = await waitForSeverity(2, 15000);
                assert.ok(
                    report?.items?.some(
                        (x) => x.code === "CS0219" && x.severity === 2,
                    ),
                    "baseline compiler warning must exist",
                );
                writeFileSync(
                    join(root, ".globalconfig"),
                    "is_global = true\ndotnet_diagnostic.CS0219.severity = error\n",
                );
                report = await waitForSeverity(1, 20000);
                assert.ok(
                    report?.items?.some(
                        (x) => x.code === "CS0219" && x.severity === 1,
                    ),
                    "new globalconfig must change CS0219 to an error without restarting",
                );
            },
        );
    },
);
