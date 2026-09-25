// Implements [DIST-CI-RIDER]: tools/rider/gradle.sh finds a JDK 21+ wherever the
// three supported platforms install one, and a machine without one either fails
// (RIDER_REQUIRED) or skips visibly — never a silent green (GitHub #274).
//
// Each case hands the script a fixture machine through RIDER_JDK_SYSROOT, with
// JAVA_HOME and RIDER_REQUIRED stripped from the inherited environment, so the
// runner's own JDKs can neither satisfy nor spoil an assertion.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "gradle.sh");
const HOMEBREW = "libexec/openjdk.jdk/Contents/Home";

/** The spelling a POSIX shell uses for `path` (Git Bash on Windows: `/c/...`). */
function shellPath(path) {
    if (process.platform !== "win32") return path;
    const drive = path.slice(0, 1).toLowerCase();
    return `/${drive}${path.slice(2).split("\\").join("/")}`;
}

/** An empty fixture machine, removed when the test ends. */
function machine(t) {
    const root = mkdtempSync(join(tmpdir(), "sharplsp-rider-jdk-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

/** A JDK home at `root/relative` whose `bin/java` reports `major`. */
function jdk(root, relative, major) {
    const home = join(root, ...relative.split("/"));
    mkdirSync(join(home, "bin"), { recursive: true });
    const java = join(home, "bin", "java");
    writeFileSync(java, `#!/bin/sh\necho "    java.specification.version = ${major}" >&2\n`);
    chmodSync(java, 0o755);
    return home;
}

/** Run gradle.sh against the fixture machine `root`. */
function gradle(root, args, env = {}) {
    const inherited = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !["JAVA_HOME", "RIDER_REQUIRED"].includes(name.toUpperCase())),
    );
    return spawnSync("sh", [SCRIPT, ...args], {
        encoding: "utf8",
        env: {
            ...inherited,
            RIDER_JDK_SYSROOT: shellPath(root),
            SKIPPED_LEGS_DIR: shellPath(join(root, "skipped")),
            ...env,
        },
    });
}

/** The JDK the script would build with on `root`. */
function chosen(root, env = {}) {
    const run = gradle(root, ["--jdk"], env);
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
}

test("a Homebrew JDK 21 is found when JAVA_HOME points at a 17", (t) => {
    const root = machine(t);
    const old = jdk(root, `opt/homebrew/opt/openjdk@17/${HOMEBREW}`, 17);
    const current = jdk(root, `opt/homebrew/opt/openjdk@21/${HOMEBREW}`, 21);

    assert.equal(chosen(root, { JAVA_HOME: shellPath(old) }), shellPath(current));
});

test("Intel Homebrew and /Library JDKs are searched too", (t) => {
    const intel = machine(t);
    const brewed = jdk(intel, `usr/local/opt/openjdk/${HOMEBREW}`, 25);
    assert.equal(chosen(intel), shellPath(brewed), "Intel Homebrew keg");

    const system = machine(t);
    const installed = jdk(system, "Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home", 21);
    assert.equal(chosen(system), shellPath(installed), "a JDK installed into /Library");
});

test("JAVA_HOME wins when it is new enough", (t) => {
    const root = machine(t);
    jdk(root, "usr/lib/jvm/java-21", 21);
    const preferred = jdk(root, "custom/jdk-22", 22);

    assert.equal(chosen(root, { JAVA_HOME: shellPath(preferred) }), shellPath(preferred));
});

test("a JDK below 21 is never chosen", (t) => {
    const root = machine(t);
    jdk(root, "usr/lib/jvm/java-17", 17);
    jdk(root, "Library/Java/JavaVirtualMachines/openjdk-17.jdk/Contents/Home", 17);

    assert.equal(chosen(root), "");
});

test("no JDK: a local run skips visibly and leaves a marker; RIDER_REQUIRED fails", (t) => {
    const root = machine(t);
    const marker = join(root, "skipped", "rider-koverXmlReport");

    const local = gradle(root, ["koverXmlReport"]);
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /Skipping Rider 'koverXmlReport' \(no JDK 21\+ found/);
    assert.ok(existsSync(marker), "the skip is recorded for the make test / make ci summary");
    assert.match(readFileSync(marker, "utf8"), /^Rider 'koverXmlReport': no JDK 21\+ found/);

    const required = gradle(root, ["koverXmlReport"], { RIDER_REQUIRED: "1" });
    assert.equal(required.status, 1);
    assert.match(required.stderr, /ERROR: Rider needs JDK 21\+/);
    assert.doesNotMatch(required.stdout, /Skipping/);
});

test("no task at all is a usage error", (t) => {
    const run = gradle(machine(t), []);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /usage: .*<gradle-task>/);
});
