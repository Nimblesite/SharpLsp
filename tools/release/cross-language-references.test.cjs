// Skipped regression for #557: cross-language F# -> C# references missing a field-type
// use location in published v0.33.0.
// Run with: RUN_RELEASE_REGRESSIONS=1 SHARPLSP_RELEASE_BUNDLE=/abs/path node tools/release/cross-language-references.test.cjs
const test = require("node:test");
const assert = require("node:assert");
const { withReleaseHost, skipUnlessEnabled } = require("./release-host.cjs");

// Exact source samples from target/codex1-release-v0330/cross-language.
const greeterCs = `namespace SharedCSharp;
public class Greeter { public string Greet(string name) => name; }
public class Consumer { public Greeter Value = new Greeter(); }
`;
const programFs = `module FSharpConsumer.Program
open SharedCSharp
let greeter = Greeter()
let message = greeter.Greet("world")
`;
const files = {
    "Directory.Build.props": "<Project />",
    "Directory.Build.targets": "<Project />",
    "Cross.slnx":
        '<Solution><Project Path="SharedCSharp/SharedCSharp.csproj" /><Project Path="FSharpConsumer/FSharpConsumer.fsproj" /></Solution>',
    "SharedCSharp/SharedCSharp.csproj":
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
    "SharedCSharp/Greeter.cs": greeterCs,
    "FSharpConsumer/FSharpConsumer.fsproj":
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Include="Program.fs" /><ProjectReference Include="../SharedCSharp/SharedCSharp.csproj" /></ItemGroup></Project>',
    "FSharpConsumer/Program.fs": programFs,
};

const expectedAll = [
    { uri: "FSharpConsumer/Program.fs", line: 2, character: 14 },
    { uri: "SharedCSharp/Greeter.cs", line: 1, character: 13 },
    { uri: "SharedCSharp/Greeter.cs", line: 2, character: 31 },
    { uri: "SharedCSharp/Greeter.cs", line: 2, character: 51 },
];
const expectedNoDecl = expectedAll.filter(
    (e) => !(e.uri === "SharedCSharp/Greeter.cs" && e.line === 1),
);

test(
    "#557 F# references to Greeter include C# declaration and both field/constructor uses in released v0.33.0 bundle",
    {
        skip: skipUnlessEnabled(
            "#557 cross-language F# references missing field-type use in published v0.33.0",
        ),
    },
    async () => {
        await withReleaseHost(
            {
                prefix: "sharplsp-557-",
                entry: "FSharpConsumer/FSharpConsumer.fsproj",
                files,
            },
            async ({ request, open, uri }) => {
                await open("FSharpConsumer/Program.fs", "fsharp");
                const document = { uri: uri("FSharpConsumer/Program.fs") };
                const position = { line: 2, character: 14 }; // Greeter() constructor call

                const ready = await request("textDocument/hover", {
                    textDocument: document,
                    position,
                });
                assert.ok(
                    ready?.contents?.value.includes("Greeter"),
                    "compiler resolves the C# type",
                );
                for (const [includeDeclaration, expected] of [
                    [true, expectedAll],
                    [false, expectedNoDecl],
                ]) {
                    const found = await request("textDocument/references", {
                        textDocument: document,
                        position,
                        context: { includeDeclaration },
                    });
                    const actual = (found ?? []).map((location) => ({
                        uri: location.uri,
                        line: location.range.start.line,
                        character: location.range.start.character,
                    }));
                    assert.deepStrictEqual(
                        actual,
                        expected.map((location) => ({
                            ...location,
                            uri: uri(location.uri),
                        })),
                        `complete reference set, includeDeclaration=${includeDeclaration}`,
                    );
                }
            },
        );
    },
);
