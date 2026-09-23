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
        const sidecars = join(root, "src", "sidecars");
        mkdirSync(sidecars, { recursive: true });
        writeFileSync(join(sidecars, "SharpLsp.Sidecars.sln"), "fixture");
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
