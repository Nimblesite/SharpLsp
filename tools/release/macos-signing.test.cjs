// #47 Distribution signatures on actual release executables. [SHARPLSP-DISTRIBUTION]
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { requireBundle, skipUnlessEnabled } = require("./release-host.cjs");

function codesign(executable, options) {
    const result = spawnSync("/usr/bin/codesign", [...options, executable], {
        encoding: "utf8",
        timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result;
}

function assertDistributionSigning(context, name) {
    const executable = requireBundle()[name];
    const verified = codesign(executable, ["--verify", "--strict"]);
    const metadata = codesign(executable, ["--display", "--verbose=4"]).stderr;
    const facts = { executable, integrityExit: verified.status, metadata };
    context.diagnostic(JSON.stringify(facts));
    assert.match(metadata, /Authority=Developer ID Application:/);
    assert.match(metadata, /flags=.*\bruntime\b/);
    assert.match(metadata, /Timestamp=/);
}

for (const name of ["host", "csharp", "fsharp"]) {
    test(
        `#47 ${name} has Developer ID distribution signing`,
        {
            skip:
                process.platform === "darwin"
                    ? skipUnlessEnabled(
                          "#47 v0.33.0 macOS binaries have only ad-hoc signatures",
                      )
                    : "requires macOS codesign",
        },
        (context) => assertDistributionSigning(context, name),
    );
}
