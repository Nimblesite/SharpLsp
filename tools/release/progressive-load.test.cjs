// Published-only #563. [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH] [DIAG-RESTORE]
const test = require("node:test");
const { withReleaseHost, skipUnlessEnabled } = require("./release-host.cjs");
const {
    fixtureFiles,
    prepareFixture,
    verifyStableInputs,
} = require("./fixtures/progressive-load.cjs");

async function runScenario(context, unrelated) {
    const evidence = { unrelated, iterations: [] };
    const options = {
        prefix: "slsp-progressive-",
        files: fixtureFiles(unrelated),
        entry: "Selected/Selected.fsproj",
        prepare: (root) => prepareFixture(root, evidence),
    };
    try {
        await withReleaseHost(options, (client) =>
            verifyStableInputs(client, evidence),
        );
    } finally {
        context.diagnostic(JSON.stringify(evidence));
    }
}

for (const unrelated of [1, 31]) {
    test(
        `#563 selected F# solution avoids ${unrelated} unrelated project(s) and repeated restores`,
        {
            timeout: 180000,
            skip: skipUnlessEnabled(
                "#563 v0.33.0 opens and restores F# projects outside the selected solution",
            ),
        },
        (context) => runScenario(context, unrelated),
    );
}
