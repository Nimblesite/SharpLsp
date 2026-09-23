// Implements [DIST-CI-AUDIT]. Parse the actual workflows, not their comments.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
    new URL("../../src/editors/vscode/package.json", import.meta.url),
);
const { load } = require("js-yaml");
const workflow = (name) =>
    load(
        readFileSync(
            new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
            "utf8",
        ),
    );
const ci = workflow("ci");
const release = workflow("release");
const action = (name) =>
    load(
        readFileSync(
            new URL(
                `../../.github/actions/${name}/action.yml`,
                import.meta.url,
            ),
            "utf8",
        ),
    );

// [DIST-VSIX-REBUILD] + [DIST-CI-VSIX-SHARDS]. A CI consumer may skip the
// rebuild ONLY by declaring the binaries came from this run, and a shard that
// declares it must also have downloaded them - a shard claiming prebuilt
// binaries it never fetched would run the suite against whatever bin/ held.
// Release declares nothing, so a tag compiles its own.
test("CI stages same-run binaries and release compiles its own", () => {
    const payload = action("vsix-payload").runs.steps;
    assert.ok(
        payload.some((step) => step.run === "env VSIX_PREBUILT=1 make _build-vsix"),
        "packaging the payload must stage what this run built, not rebuild it",
    );
    const shard = action("vsix-shard").runs.steps;
    const run = shard.find((step) =>
        step.run?.includes("make _test-vsix-shard"),
    );
    assert.ok(run, "the shard action must invoke the shard target");
    assert.equal(
        run.env?.VSIX_PREBUILT,
        "1",
        "a shard must not rebuild Rust, both sidecars and netcoredbg per chunk",
    );
    assert.equal(
        run.env?.VSIX_SUITE_PREBUILT,
        "1",
        "nor recompile the shard-independent suite per chunk",
    );
    const downloads = shard.filter((step) =>
        step.uses?.startsWith("actions/download-artifact@"),
    );
    assert.ok(
        downloads.length >= 3,
        `declaring prebuilt binaries obliges the shard to download them; found ${String(downloads.length)}`,
    );
    assert.equal(run["continue-on-error"], undefined, "a shard may not be advisory");
    const pkg = release.jobs["build-vsix"].steps.find((step) =>
        step.run?.includes("make _package-vsix-${{ matrix.platform }}"),
    );
    assert.ok(pkg, "release must package through the per-platform target");
    assert.equal(
        pkg.env?.VSIX_PREBUILT,
        undefined,
        "a tag must never declare prebuilt: it compiles its own binaries",
    );
});

test("a dependency audit failure reaches the final CI result", () => {
    assert.ok(
        ci.jobs.ci.needs.includes("audit"),
        "CI must depend on the vulnerability audit",
    );
    assert.equal(ci.jobs.ci.if, "${{ always() }}");
    const failure = ci.jobs.ci.steps.find((step) =>
        step.if?.includes("contains(needs.*.result, 'failure')"),
    );
    assert.ok(failure, "a failed dependency must fail the final gate");
    assert.ok(failure.run.includes("exit 1"));
    assert.notEqual(ci.jobs.audit["continue-on-error"], true);
});

test("CI and release run the same non-optional vulnerability scanner", () => {
    for (const caller of [ci, release]) {
        assert.equal(
            caller.jobs.audit.uses,
            "./.github/workflows/ci-audit.yml",
        );
        assert.notEqual(caller.jobs.audit["continue-on-error"], true);
    }
    const audit = workflow("ci-audit");
    assert.ok(Object.hasOwn(audit.on, "workflow_call"));
    const scanner = audit.jobs.audit.steps.find(
        (step) => step.run === "make audit",
    );
    assert.ok(scanner, "the shared audit must execute the real local scanner");
    assert.equal(scanner.if, undefined, "the scanner cannot be conditional");
    assert.notEqual(scanner["continue-on-error"], true);
});

test("vulnerability findings block the release and both VSIX marketplaces", () => {
    assert.ok(release.jobs.release.needs.includes("audit"));
    assert.equal(
        release.jobs.release.if,
        undefined,
        "release must use success-only dependency gating",
    );
    assert.equal(
        release.jobs.audit.if,
        undefined,
        "every tagged release must be audited",
    );
    for (const name of ["publish-marketplace", "publish-openvsx"]) {
        assert.ok(
            release.jobs[name].needs.includes("release"),
            `${name} must wait for the audited release`,
        );
        assert.equal(
            release.jobs[name].if,
            undefined,
            `${name} cannot bypass dependency success`,
        );
    }
});
