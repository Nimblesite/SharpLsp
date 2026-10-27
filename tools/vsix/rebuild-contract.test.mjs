// [DIST-VSIX-REBUILD] Check lifecycle entry points and real stale output removal.
import assert from "node:assert/strict";
import test from "node:test";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    existsSync,
    rmSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSidecarOutput } from "./clean-sidecar-output.mjs";

const manifest = JSON.parse(
    readFileSync(
        new URL("../../src/editors/vscode/package.json", import.meta.url),
    ),
);

test("npm test and npm package cannot skip rebuilding binaries", () => {
    const scripts = manifest.scripts;
    assert.equal(
        scripts["prepare:vsix-binaries"],
        "make -C ../../.. _stage-vsix-binary",
    );
    assert.ok(
        scripts.pretest.includes("prepare:vsix-binaries"),
        "npm test must rebuild",
    );
    assert.ok(
        scripts["vscode:prepublish"].includes("prepare:vsix-binaries"),
        "direct vsce must rebuild",
    );
    assert.equal(
        scripts["test:run"],
        "npm run test",
        "alternate runner must use the same lifecycle",
    );
});

test("clean removes stale BuildHost bin/obj/publish files but preserves source and unrelated output", () => {
    const root = mkdtempSync(join(tmpdir(), "sharplsp-clean-contract-"));
    try {
        const sidecars = sidecarTree(root);
        const names = [
            "SharpLsp.Sidecar.CSharp",
            "SharpLsp.Sidecar.FSharp",
            "SharpLsp.Sidecar.Common",
            "SharpLsp.Sidecar.CSharp.Tests",
        ];
        const stale = seedOutputs(root, sidecars, names);
        cleanSidecarOutput(root);
        for (const output of stale)
            assert.equal(existsSync(output), false, `must remove ${output}`);
        for (const name of names)
            assert.equal(
                readFileSync(join(sidecars, name, "Source.cs"), "utf8"),
                "source",
            );
        assert.equal(
            readFileSync(join(root, "target", "keep.txt"), "utf8"),
            "keep",
        );
        cleanSidecarOutput(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

function sidecarTree(root) {
    const sidecars = join(root, "src", "sidecars");
    mkdirSync(sidecars, { recursive: true });
    writeFileSync(join(sidecars, "SharpLsp.Sidecars.sln"), "fixture");
    return sidecars;
}

function seedOutputs(root, sidecars, names) {
    const outputs = [];
    for (const name of names) {
        const project = join(sidecars, name);
        mkdirSync(project, { recursive: true });
        const extension = name.includes("FSharp") ? "fsproj" : "csproj";
        writeFileSync(
            join(project, `${name}.${extension}`),
            '<Project Sdk="Microsoft.NET.Sdk" />',
        );
        writeFileSync(join(project, "Source.cs"), "source");
        outputs.push(join(project, "bin"), join(project, "obj"));
    }
    outputs.push(
        join(root, "target", "sidecar-csharp"),
        join(root, "target", "sidecar-fsharp"),
    );
    for (const output of outputs) {
        mkdirSync(join(output, "BuildHost-netcore"), { recursive: true });
        writeFileSync(
            join(output, "BuildHost-netcore", "stale.deps.json"),
            '{"version":"5.9"}',
        );
    }
    writeFileSync(join(root, "target", "keep.txt"), "keep");
    return outputs;
}

// [DIST-VSIX-REBUILD] `reinstall-vsix` kills the installed servers, VS Code's
// language client restarts them at once, and their MSBuild design-time builds
// write into the very bin/obj the clean is deleting. That race failed the whole
// loop with ENOTEMPTY before a single binary was rebuilt.
test("clean outlasts a restarted language server writing into the output it removes", async () => {
    const root = mkdtempSync(join(tmpdir(), "sharplsp-clean-race-"));
    try {
        const sidecars = sidecarTree(root);
        const project = join(sidecars, "SharpLsp.Sidecar.FSharp");
        seedOutputs(root, sidecars, ["SharpLsp.Sidecar.FSharp"]);
        const designTime = join(project, "bin", "Debug", "net10.0");
        mkdirSync(designTime, { recursive: true });
        for (let i = 0; i < 2000; i++)
            writeFileSync(join(designTime, `seed-${i}.dll`), "");
        const writer = startDesignTimeWriter(designTime, 400);
        await writer.ready;

        assert.doesNotThrow(() => cleanSidecarOutput(root));
        assert.equal(existsSync(join(root, "target", "sidecar-fsharp")), false);
        assert.equal(
            readFileSync(join(project, "Source.cs"), "utf8"),
            "source",
        );
        assert.ok(
            existsSync(join(project, "SharpLsp.Sidecar.FSharp.fsproj")),
            "project file must survive",
        );

        assert.ok(
            (await writer.written) > 0,
            "writer must have raced the clean",
        );
        cleanSidecarOutput(root);
        assert.equal(existsSync(join(project, "bin")), false);
        assert.equal(existsSync(join(project, "obj")), false);
        assert.equal(
            readFileSync(join(root, "target", "keep.txt"), "utf8"),
            "keep",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// A separate process, as the real writer is: the clean is synchronous and
// would starve an in-process writer of the event loop.
function startDesignTimeWriter(directory, ms) {
    const script = [
        'const { mkdirSync, writeFileSync } = require("node:fs");',
        "const [directory, ms] = process.argv.slice(1);",
        "let end;",
        "let written = 0;",
        "while (end === undefined || Date.now() < end) {",
        "  try {",
        "    mkdirSync(directory, { recursive: true });",
        '    writeFileSync(`${directory}/design-time-${written}.dll`, "");',
        "    written++;",
        '    if (written === 1) { process.stdout.write("ready\\n"); end = Date.now() + Number(ms); }',
        "  } catch { /* the clean removed the directory mid-write */ }",
        "}",
        "process.stdout.write(String(written));",
    ].join("\n");
    const child = spawn(process.execPath, [
        "-e",
        script,
        directory,
        String(ms),
    ]);
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    return {
        ready: once(child.stdout, "data"),
        // `exit` can precede the last stdout data on Windows; `close` has drained it.
        written: once(child, "close").then(() =>
            Number(Buffer.concat(chunks).toString().split("\n").at(-1)),
        ),
    };
}
