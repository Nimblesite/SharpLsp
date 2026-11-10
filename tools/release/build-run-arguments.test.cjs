// [SE-ACTIONS-ARGS] #271 Published extension must expose build/run/test argument configuration.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join, isAbsolute } = require("node:path");
const { skipUnlessEnabled } = require("./release-host.cjs");

function manifest() {
    const extension = process.env.SHARPLSP_RELEASE_VSIX;
    assert.ok(
        extension && isAbsolute(extension),
        "SHARPLSP_RELEASE_VSIX must identify the extracted official extension",
    );
    const result = JSON.parse(
        readFileSync(join(extension, "package.json"), "utf8"),
    );
    assert.equal(result.publisher, "nimblesite");
    assert.equal(result.name, "sharplsp");
    assert.equal(result.version, "0.33.0");
    return result;
}

for (const command of [
    "sharplsp.configureBuildArgs",
    "sharplsp.configureRunArgs",
]) {
    test(
        `#271 published extension contributes ${command}`,
        {
            skip: skipUnlessEnabled(
                "#271 argument configuration commands are absent from v0.33.0",
            ),
        },
        () => {
            assert.ok(
                manifest().contributes.commands.some(
                    (item) => item.command === command,
                ),
                `${command} must be available in the released extension`,
            );
        },
    );
}

for (const setting of [
    "sharplsp.build.extraArgs",
    "sharplsp.run.extraArgs",
    "sharplsp.test.extraArgs",
]) {
    test(
        `#271 published extension declares ${setting} as a string array`,
        {
            skip: skipUnlessEnabled(
                "#271 build/run/test argument settings are absent from v0.33.0",
            ),
        },
        () => {
            const configuration = manifest().contributes.configuration;
            const groups = Array.isArray(configuration)
                ? configuration
                : [configuration];
            const property = groups
                .flatMap((group) => Object.entries(group.properties ?? {}))
                .find(([name]) => name === setting)?.[1];
            assert.ok(
                property,
                `${setting} must be declared by the released extension`,
            );
            assert.equal(property.type, "array");
            assert.equal(property.items.type, "string");
        },
    );
}
