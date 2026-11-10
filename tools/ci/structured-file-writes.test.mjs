// Implements [SHARPLSP-ARCHITECTURE-STRUCTURED-EDITS]: the gate run over a real
// git repository, and over this one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repository as gitRepository } from "./git-fixture.mjs";
import test from "node:test";
import { bannedWrite, violations } from "./structured-file-writes.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "structured-file-writes.mjs");

/** A git repository holding `files`, removed when the test ends. */
const repository = (t, files) => gitRepository(t, "sharplsp-structured-writes-", files);

test("a whole-string write of a project, solution or manifest is banned in every language", () => {
    for (const line of [
        `fs.writeFileSync(join(dir, 'App.csproj'), text);`,
        `fs.writeFileSync(\`\${name}.fsproj\`, xml, 'utf8');`,
        `File.WriteAllText(Path.Combine(dir, "Directory.Build.props"), xml);`,
        `File.WriteAllText(dir + "/Build.targets", xml) |> ignore`,
        `std::fs::write(root.join("App.sln"), text)?;`,
        `std::fs::write(root.join("App.slnx"), text)?;`,
        `fs.writeFileSync(path.join(out, 'extension.vsixmanifest'), manifest);`,
    ]) {
        assert.equal(bannedWrite(line), true, line);
    }
});

test("other writes, reads and DOM edits are not banned", () => {
    for (const line of [
        `fs.writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));`,
        `fs.writeFileSync(join(dir, 'Program.cs'), source);`,
        `File.WriteAllText(path, text)`,
        `std::fs::write(path, content)?;`,
        `const text = fs.readFileSync(join(dir, 'App.csproj'), 'utf8');`,
        `project.Save(); // App.csproj through ProjectRootElement`,
        `fs.writeFileSync(join(dir, 'App.csprojx'), text);`,
    ]) {
        assert.equal(bannedWrite(line), false, line);
    }
});

test("only production source is gated: tests, fixtures and the website write fixture projects", (t) => {
    const write = `fs.writeFileSync(join(dir, 'App.csproj'), text);\n`;
    const root = repository(t, {
        "src/editors/vscode/src/scaffold.ts": write,
        "src/sharplsp/src/edit.rs": `std::fs::write(dir.join("App.fsproj"), xml)?;\n`,
        "src/sidecars/Sidecar/Edit.cs": `File.WriteAllText(dir + "/Build.props", xml);\n`,
        "src/editors/vscode/src/test/suite/kit.ts": write,
        "src/sharplsp/tests/e2e.rs": `std::fs::write(dir.join("App.fsproj"), xml)?;\n`,
        "src/sharplsp/src/edit_tests.rs": `std::fs::write(dir.join("App.fsproj"), xml)?;\n`,
        "src/sidecars/Sidecar.Tests/Fixture.cs": `File.WriteAllText(dir + "/App.csproj", xml);\n`,
        "src/website/tools/film.mjs": write,
        "src/sharplsp/tests/fixtures/make.mjs": write,
        "src/editors/vscode/src/settings.ts": `fs.writeFileSync('a.json', '{}');\n`,
    });
    assert.deepEqual(violations(root).sort(), [
        `src/editors/vscode/src/scaffold.ts:1:${write.trimEnd()}`,
        `src/sharplsp/src/edit.rs:1:std::fs::write(dir.join("App.fsproj"), xml)?;`,
        `src/sidecars/Sidecar/Edit.cs:1:File.WriteAllText(dir + "/Build.props", xml);`,
    ]);
});

test("a repository without a single write call has no violations", (t) => {
    const root = repository(t, { "src/a.ts": "export const a = 1;\n" });
    assert.deepEqual(violations(root), []);
});

test("the CLI fails naming each violation, and passes on this repository", (t) => {
    const root = repository(t, { "src/a.ts": `fs.writeFileSync('A.csproj', x);\n` });
    const failing = spawnSync(process.execPath, [GATE, root], { encoding: "utf8" });
    assert.equal(failing.status, 1, failing.stdout);
    assert.match(failing.stderr, /\[SHARPLSP-ARCHITECTURE-STRUCTURED-EDITS\]/);
    assert.match(failing.stderr, /src\/a\.ts:1:fs\.writeFileSync\('A\.csproj', x\);/);
    const own = spawnSync(process.execPath, [GATE], { encoding: "utf8" });
    assert.equal(own.status, 0, own.stderr);
    assert.match(own.stdout, /none outside the project DOM/);
});
