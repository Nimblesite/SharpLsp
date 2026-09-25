// Implements [DIST-CI-SPEC-CITATIONS]: every rule of the citation gate, run by
// the real CLI over a real git repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { definedByHeading, headingIds, idsIn, problems } from "./spec-citations.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "spec-citations.mjs");

const SPEC = [
    "# [DEMO-SPEC] Demo",
    "",
    "## [DEMO-LOGIN] Login",
    "",
    "### Token check `[DEMO-LOGIN-TOKEN]`",
    "",
    "```toml",
    "# [DEMO-LOGIN] — a TOML comment: were it a heading, [DEMO-LOGIN] would be defined twice",
    "```",
    "",
].join("\n");

/** A git repository holding `files`, removed when the test ends. */
function repository(t, files) {
    const root = mkdtempSync(join(tmpdir(), "sharplsp-spec-citations-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text, "utf8");
    }
    const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(git("init", "--quiet").status, 0);
    assert.equal(git("add", "--all").status, 0);
    return root;
}

/** Run the real gate over `root`. */
function gate(root) {
    return spawnSync(process.execPath, [GATE, root], { encoding: "utf8" });
}

test("a clean repository passes and says so", (t) => {
    const root = repository(t, {
        "docs/specs/DEMO-SPEC.md": SPEC,
        "src/login.ts": "// Implements [DEMO-LOGIN] and [DEMO-LOGIN-TOKEN].\n",
        "README.md": "See [DEMO-SPEC] for the whole document.\n",
    });
    const run = gate(root);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Every spec citation resolves to exactly one definition/);
    assert.equal(run.stderr, "");
});

test("a citation nothing defines fails with its file and line", (t) => {
    const root = repository(t, {
        "docs/specs/DEMO-SPEC.md": SPEC,
        "src/login.ts": "// fine: [DEMO-LOGIN]\n// gone: [DEMO-LOGOUT]\n",
    });
    const run = gate(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^src\/login\.ts:2: \[DEMO-LOGOUT\] is cited but no heading defines it$/m);
    assert.doesNotMatch(run.stderr, /\[DEMO-LOGIN\] is cited/, "a defined ID is never reported");
    assert.match(run.stderr, /ERROR: 1 spec citation problem\(s\)/);
});

test("an untracked file is not scanned, a tracked one is", (t) => {
    const root = repository(t, { "docs/specs/DEMO-SPEC.md": SPEC, "src/a.ts": "// [DEMO-A-GONE]\n" });
    writeFileSync(join(root, "scratch.ts"), "// [DEMO-UNTRACKED]\n", "utf8");
    const run = gate(root);
    assert.match(run.stderr, /src\/a\.ts:1: \[DEMO-A-GONE\]/);
    assert.doesNotMatch(run.stderr, /DEMO-UNTRACKED/, "git decides what the repository is");
});

test("a heading mention in parentheses keeps no deleted section alive", (t) => {
    const root = repository(t, {
        "docs/specs/DEMO-SPEC.md": SPEC,
        "docs/plans/DEMO-PLAN.md": "# Plan\n\n### Logout work ([DEMO-LOGOUT])\n",
        "src/logout.ts": "// Implements [DEMO-LOGOUT].\n",
    });
    const run = gate(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /src\/logout\.ts:1: \[DEMO-LOGOUT\] is cited but no heading defines it/);
});

test("two headings defining one ID fail, naming both documents", (t) => {
    const root = repository(t, {
        "docs/specs/DEMO-SPEC.md": SPEC,
        "docs/plans/DEMO-PLAN.md": "# Plan\n\n### Login again — [DEMO-LOGIN]\n",
    });
    const run = gate(root);
    assert.equal(run.status, 1);
    assert.match(
        run.stderr,
        /\[DEMO-LOGIN\] is defined by more than one heading: docs\/plans\/DEMO-PLAN\.md, docs\/specs\/DEMO-SPEC\.md/,
    );
});

test("a spec or plan document may be cited whole by its name", (t) => {
    const texts = new Map([
        ["docs/specs/DEMO-SPEC.md", SPEC],
        ["docs/plans/DEMO-PLAN.md", "# Plan\n"],
        ["src/a.ts", "// See [DEMO-SPEC] and [DEMO-PLAN].\n// Not a document: [DEMO-NOTES]\n"],
    ]);
    assert.deepEqual(problems(texts), ["src/a.ts:2: [DEMO-NOTES] is cited but no heading defines it"]);
});

test("the ID-format examples are exempt, and only they are", () => {
    const texts = new Map([
        ["AGENTS.md", "Cite `[GROUP-TOPIC]` or `[GROUP-TOPIC-DETAIL]`, e.g. [AUTH-TOKEN-VERIFY].\n"],
        [".agents/skills/spec-check/SKILL.md", "Examples: [SPEC-001], [EXAMPLE-LOGIN].\n"],
        ["src/a.ts", "// [EXAMPLE-LOGIN]\n"],
    ]);
    assert.deepEqual(problems(texts), ["src/a.ts:1: [EXAMPLE-LOGIN] is cited but no heading defines it"]);
});

test("a heading defines each ID outside parentheses and none inside them", () => {
    assert.deepEqual(definedByHeading("[DEMO-A] Title"), ["DEMO-A"]);
    assert.deepEqual(definedByHeading("Title `[DEMO-B]`"), ["DEMO-B"]);
    assert.deepEqual(definedByHeading("[DEMO-C] / [DEMO-D]"), ["DEMO-C", "DEMO-D"]);
    assert.deepEqual(definedByHeading("Work (`[DEMO-E]`, [DEMO-F])"), []);
    assert.deepEqual(definedByHeading("Done (see notes) — [DEMO-G]"), ["DEMO-G"]);
});

test("markdown is lexed, so a fenced # line is not a heading", () => {
    assert.deepEqual(headingIds(SPEC), ["DEMO-SPEC", "DEMO-LOGIN", "DEMO-LOGIN-TOKEN"]);
});

test("links, placeholders and regex classes are not citations", () => {
    assert.deepEqual(idsIn("[JSON-RPC](https://www.jsonrpc.org) over stdio"), []);
    assert.deepEqual(idsIn("[SIDECAR-STARTUP-ENDPOINT](SIDECAR-LIFECYCLE-SPEC.md)"), [
        "SIDECAR-STARTUP-ENDPOINT",
    ]);
    assert.deepEqual(idsIn("/[A-Z]/ and [A-Z0-9] and [EDITED] and [PROJECT]"), []);
    assert.deepEqual(idsIn("// Implements [DIST-CI-WIN-VSIX] / [DIST-CI-SMOKE]."), [
        "DIST-CI-WIN-VSIX",
        "DIST-CI-SMOKE",
    ]);
});
