// Execute the real shared debug-suite teardown with failures at its external
// boundaries. This tests harness isolation, not a substitute debugger or app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const suiteDir = new URL(
    "../../src/editors/vscode/src/test/suite/",
    import.meta.url,
);
const shared = readFileSync(new URL("debug-suite-kit.ts", suiteDir), "utf8");
const cleanup = shared.match(
    /async function cleanupDebugTest\([\s\S]*?\): Promise<void> (\{[\s\S]*?^\})/m,
);
// Every debug suite arms its recorders through useArmedRecorders, so its one
// teardown is the hook that must survive a failed Stop.
const files = ["debug-suite-kit.ts"];

for (const file of files) {
    const source = readFileSync(new URL(file, suiteDir), "utf8");
    const hook = source.match(
        /teardown\((async (?:function \(\)|\(\) =>) \{[\s\S]*?\n\s*\})\);/,
    );
    assert.ok(hook, `${file} must register its teardown hook`);
    for (const failureAt of ["stop", "breakpoints", undefined]) {
        test(`${file} restores isolation after ${failureAt ?? "successful stop"}`, async () => {
            const calls = [];
            const failure = new Error(`deliberate ${failureAt} failure`);
            const action = (name) => () => {
                calls.push(name);
                if (name === failureAt) throw failure;
            };
            const state = {
                current: {
                    sessions: { dispose: action("sessions") },
                    recorder: { dispose: action("recorder") },
                    stubs: { restore: action("stubs") },
                },
                stopDebuggee: action("stop"),
                clearAllBreakpoints: action("breakpoints"),
                closeAllEditors: action("editors"),
                DEBUG_SESSION_MS: 45_000,
            };
            Object.assign(state, state.current);
            if (cleanup) {
                state.cleanupDebugTest = runInNewContext(
                    `(async (active) => ${cleanup[1]})`,
                    state,
                );
            }
            // This callback is JavaScript already; no transpiler or npm dependency
            // is needed in the Linux Tooling job. Execute exactly the authored hook.
            const teardown = runInNewContext(`(${hook[1]})`, state);
            const result = teardown.call({ timeout() {} });
            if (failureAt)
                await assert.rejects(result, (error) => error === failure);
            else await result;
            if (file === "debug-suite-kit.ts") {
                assert.equal(
                    state.current,
                    undefined,
                    "a completed hook releases its per-test harness",
                );
            }
            assert.deepEqual(
                calls,
                [
                    "stop",
                    "breakpoints",
                    "sessions",
                    "recorder",
                    "stubs",
                    "editors",
                ],
                "a failed Stop or breakpoint assertion must still restore every test-owned observer and UI stub",
            );
        });
    }
}
