// Implements [DIAG-HYGIENE-GUARD]: the gate's own rules — framing, flattening,
// the allow-list and the failing severity — over reports shaped like the host's.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parseArguments, rowsOf, summary, takeMessages, violations } from "./workspace-diagnostics.mjs";

const frame = (body) => {
    const text = JSON.stringify(body);
    return Buffer.from(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
};

const report = (file, ...items) => ({ uri: pathToFileURL(file).href, kind: "full", items });
const diagnostic = (code, severity, line = 0) => ({
    code,
    severity,
    message: `${code} happened`,
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
});

test("framed messages split off whole, a partial one waits for its bytes, multi-byte text counts in bytes", () => {
    const first = frame({ id: 1, result: "héllo" });
    const second = frame({ method: "workspace/diagnostic/refresh", id: 7 });
    const joined = Buffer.concat([first, second]);

    const whole = takeMessages(joined);
    assert.deepEqual(whole.messages, [{ id: 1, result: "héllo" }, { method: "workspace/diagnostic/refresh", id: 7 }]);
    assert.equal(whole.rest.length, 0);

    const cut = takeMessages(joined.subarray(0, first.length + 10));
    assert.deepEqual(cut.messages, [{ id: 1, result: "héllo" }]);
    assert.equal(cut.rest.length, 10, "the second message's first bytes are kept for the next chunk");

    const headerOnly = takeMessages(Buffer.from("Content-Length: 5\r\n"));
    assert.deepEqual(headerOnly.messages, []);
    assert.equal(headerOnly.rest.toString(), "Content-Length: 5\r\n");
});

test("reports flatten to one row per diagnostic with a one-based line and a named severity", () => {
    const rows = rowsOf([
        report("/repo/src/App.fs", diagnostic("FS0001", 1, 4), diagnostic("FL0067", 2)),
        report("/repo/src/Clean.cs"),
        { uri: pathToFileURL("/repo/src/Unchanged.cs").href, kind: "unchanged" },
        report("/repo/src/Tool.cs", { ...diagnostic(undefined, undefined, 2), code: undefined }),
    ]);
    assert.deepEqual(
        rows.map((row) => [row.file, row.line, row.severity, row.code]),
        [
            ["/repo/src/App.fs", 5, "error", "FS0001"],
            ["/repo/src/App.fs", 1, "warning", "FL0067"],
            ["/repo/src/Tool.cs", 3, "error", ""],
        ],
    );
    assert.equal(rows[0].message, "FS0001 happened");
});

test("a violation is a diagnostic at or above the failing severity outside every allowed path part", () => {
    const rows = rowsOf([
        report("/repo/src/App.fs", diagnostic("FS0001", 1), diagnostic("FL0067", 2), diagnostic("SLSPF0102", 4)),
        report("/repo/test-fixtures/diagnostic-lint/Lint.fs", diagnostic("FL0065", 2)),
        report("C:\\repo\\fixtures\\diagnostic-tags\\Tags.cs", diagnostic("CS0168", 2)),
    ]);
    const allow = ["/diagnostic-lint", "/diagnostic-tags"];

    assert.deepEqual(violations(rows, allow, "hint").map((row) => row.code), ["FS0001", "FL0067", "SLSPF0102"]);
    assert.deepEqual(violations(rows, allow, "warning").map((row) => row.code), ["FS0001", "FL0067"]);
    assert.deepEqual(violations(rows, allow, "error").map((row) => row.code), ["FS0001"]);
    assert.equal(violations(rows, [], "hint").length, 5, "with nothing allowed the demo fixtures fail too");
    assert.deepEqual(violations(rows, [...allow, "/src/"], "hint"), []);
});

test("the summary counts each code and severity, most frequent first", () => {
    const rows = rowsOf([
        report("/repo/A.fs", diagnostic("FS3886", 2), diagnostic("FS3886", 2), diagnostic("FL0067", 2)),
        report("/repo/B.fs", diagnostic("FS3886", 2), diagnostic("FS3886", 4)),
    ]);
    assert.deepEqual(summary(rows), ["     3  FS3886 warning", "     1  FL0067 warning", "     1  FS3886 hint"]);
    assert.deepEqual(summary([]), []);
});

test("arguments override the defaults, the demo fixtures stay allowed, and a bad one is refused", () => {
    const defaults = parseArguments([]);
    assert.equal(defaults.failOn, "hint");
    assert.equal(defaults.list, false);
    assert.deepEqual(defaults.allow, ["/diagnostic-lint", "/diagnostic-tags", "/diagnostic-cancellation"]);
    assert.match(defaults.server, /target[\\/]debug[\\/]sharplsp(\.exe)?$/);

    const set = parseArguments(["--root", ".", "--server", "/bin/host", "--allow", "/demo", "--fail-on", "warning", "--timeout", "60", "--list"]);
    assert.equal(set.root, process.cwd());
    assert.equal(set.server, "/bin/host");
    assert.deepEqual(set.allow.slice(-1), ["/demo"]);
    assert.equal(set.allow.length, 4);
    assert.deepEqual([set.failOn, set.timeout, set.list], ["warning", 60, true]);

    assert.throws(() => parseArguments(["--nope"]), /unknown argument --nope/);
    assert.throws(() => parseArguments(["--fail-on", "fatal"]), /--fail-on must be one of/);
});
