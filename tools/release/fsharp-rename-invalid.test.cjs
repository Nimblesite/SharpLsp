// [RENAME-ERRORS] Published v0.33.0 accepts compiler-invalid F# identifiers.
const test = require("node:test");
const assert = require("node:assert/strict");
const cases = require("./fixtures/fsharp-rename.json");
const { withReleaseHost, skipUnlessEnabled } = require("./release-host.cjs");

for (const scenario of cases) {
    test(
        `#${scenario.issue} ${scenario.caseId ?? scenario.oldName} rejects invalid F# rename names`,
        { skip: skipUnlessEnabled(`#${scenario.issue} accepts bad!`) },
        async () => {
            const files = Object.fromEntries(
                scenario.files.map((file) => [file.name, file.text]),
            );
            files["Probe.fsproj"] =
                '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup>' +
                scenario.files
                    .map((file) => `<Compile Include="${file.name}" />`)
                    .join("") +
                "</ItemGroup></Project>";
            await withReleaseHost(
                {
                    prefix: `sharplsp-${scenario.issue}-`,
                    entry: "Probe.fsproj",
                    files,
                },
                async ({ request, open, uri }) => {
                    for (const file of scenario.files)
                        await open(file.name, "fsharp");
                    const document = { uri: uri(scenario.target.file) };
                    const position = {
                        line: scenario.target.line,
                        character:
                            scenario.target.character +
                            Math.min(1, scenario.oldName.length - 1),
                    };
                    const prepare = await request(
                        "textDocument/prepareRename",
                        { textDocument: document, position },
                    );
                    assert.equal(prepare.placeholder, scenario.oldName);
                    const valid = await request("textDocument/rename", {
                        textDocument: document,
                        position,
                        newName: scenario.newName,
                    });
                    const locations = valid.documentChanges.flatMap((doc) =>
                        doc.edits.map((edit) => {
                            assert.equal(edit.newText, scenario.newName);
                            return {
                                uri: doc.textDocument.uri,
                                ...edit.range.start,
                            };
                        }),
                    );
                    const expected = scenario.expected.map(
                        ({ file, ...position }) => ({
                            uri: uri(file),
                            ...position,
                        }),
                    );
                    const compare = (a, b) =>
                        a.uri.localeCompare(b.uri) ||
                        a.line - b.line ||
                        a.character - b.character;
                    assert.deepEqual(
                        locations.sort(compare),
                        expected.sort(compare),
                    );
                    for (const newName of scenario.invalidNames) {
                        await assert.rejects(
                            request("textDocument/rename", {
                                textDocument: document,
                                position,
                                newName,
                            }),
                            /Invalid F# rename name/,
                        );
                    }
                },
            );
        },
    );
}
