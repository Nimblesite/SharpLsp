// Real SDK project graph for #563. [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH]
const fs = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { hoverReady } = require("../release-host.cjs");
const source = "module Selected.Library\nlet answer = Shared.Api.value + 1\n";
const project = (references) =>
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Include="Library.fs"/>${references}</ItemGroup></Project>`;
const baseFiles = {
    "Directory.Build.props": "<Project/>",
    "Directory.Build.targets":
        '<Project><Target Name="RecordActualRestore" BeforeTargets="Restore"><WriteLinesToFile File="$(MSBuildProjectDirectory)/restore-runs.txt" Lines="$(MSBuildProjectName)" Overwrite="false"/></Target></Project>',
    ".editorconfig": "root = true\n",
    "sharplsp.toml": "[diagnostics]\nanalyzers_enabled = false\n",
    "Selected/Selected.fsproj": project(
        '<ProjectReference Include="../Shared/Shared.fsproj"/>',
    ),
    "Selected/Library.fs": source,
    "Shared/Shared.fsproj": project(""),
    "Shared/Library.fs": "namespace Shared\nmodule Api =\n    let value = 41\n",
};

function fixtureFiles(unrelated) {
    const files = { ...baseFiles };
    for (let index = 0; index < unrelated; index++) {
        const folder = `Unrelated${String(index).padStart(2, "0")}`;
        files[`${folder}/${folder}.fsproj`] = project("");
        files[`${folder}/Library.fs`] =
            `module ${folder}.Library\nlet value = 42\n`;
    }
    return files;
}

function findFiles(root, name) {
    return fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name === name)
        .map((entry) => join(entry.parentPath, entry.name));
}

function sdk(root, args) {
    execFileSync("dotnet", args, { cwd: root, stdio: "pipe", timeout: 30000 });
}

function createSolution(root) {
    sdk(root, ["new", "sln", "--format", "sln", "--name", "Selected"]);
    sdk(root, [
        "sln",
        "Selected.sln",
        "add",
        "Selected/Selected.fsproj",
        "Shared/Shared.fsproj",
    ]);
}

function snapshotAssets(root) {
    return findFiles(root, "project.assets.json").map((file) => {
        // One descriptor for stat and read, so both observe the same file.
        const fd = fs.openSync(file, "r");
        try {
            return {
                file,
                mtime: fs.fstatSync(fd).mtimeMs,
                sha256: createHash("sha256")
                    .update(fs.readFileSync(fd))
                    .digest("hex"),
            };
        } finally {
            fs.closeSync(fd);
        }
    });
}

function prepareFixture(root, evidence) {
    evidence.root = fs.realpathSync(root);
    createSolution(root);
    evidence.assets = snapshotAssets(evidence.root);
    assert.equal(
        evidence.assets.length,
        2,
        "only the two selected projects are built",
    );
    for (const file of findFiles(root, "restore-runs.txt")) fs.unlinkSync(file);
}

function inventory(root) {
    return {
        restores: findFiles(root, "restore-runs.txt").map((file) => ({
            file,
            text: fs.readFileSync(file, "utf8"),
        })),
        assets: findFiles(root, "project.assets.json"),
    };
}

async function loadHover(client, evidence, index) {
    const ack = await client.request("sharplsp/loadSolution", {
        solutionPath: join(evidence.root, "Selected.sln"),
    });
    assert.equal(ack.success, true);
    if (index === 0) await client.open("Selected/Library.fs", "fsharp", source);
    return hoverReady(
        client,
        {
            textDocument: { uri: client.uri("Selected/Library.fs") },
            position: { line: 1, character: 7 },
        },
        45000,
    );
}

function unrelatedRestores(result, root) {
    const allowed = [
        join(root, "Selected/restore-runs.txt"),
        join(root, "Shared/restore-runs.txt"),
    ];
    return result.restores.filter(({ file }) => !allowed.includes(file));
}

function assertSelectedResult(result, root) {
    assert.match(result.hover.contents.value, /val answer: int/);
    assert.deepEqual(
        unrelatedRestores(result, root),
        [],
        "only selected projects may restore",
    );
    assert.equal(
        result.assets.length,
        2,
        "unrelated projects must remain unrestored",
    );
    assert.ok(
        result.elapsedMs < 10000,
        "selected load must avoid unrelated cold checks",
    );
}

async function iteration(client, evidence, index) {
    const start = performance.now();
    const hover = await loadHover(client, evidence, index);
    const result = {
        index,
        elapsedMs: performance.now() - start,
        hover,
        ...inventory(evidence.root),
    };
    evidence.iterations.push(result);
    assertSelectedResult(result, evidence.root);
    if (index > 0)
        assert.deepEqual(
            result.restores,
            evidence.iterations[0].restores,
            "reopening unchanged inputs must not restore again",
        );
}

async function verifyStableInputs(client, evidence) {
    await iteration(client, evidence, 0);
    const stable = snapshotAssets(evidence.root);
    for (let index = 1; index < 3; index++)
        await iteration(client, evidence, index);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.deepEqual(
        inventory(evidence.root).restores,
        evidence.iterations[0].restores,
    );
    assert.deepEqual(
        snapshotAssets(evidence.root),
        stable,
        "unchanged repeated opens preserve SDK assets",
    );
}

module.exports = { fixtureFiles, prepareFixture, verifyStableInputs };
