#!/usr/bin/env node
// Implements [DIST-CI-SPEC-CITATIONS].
//
// Every spec ID the repository cites MUST resolve: to the one heading in `docs/`
// that defines it, or to the spec or plan document it names. A dangling
// citation is worse than none — `// Implements [DIST-RELEASE]` reads as
// "specified and reviewed" long after the section was deleted, and nothing can
// check the code against it. Twenty-four `[DIST-*]` sections vanished that way
// while release.yml kept citing them (GitHub #272, #301).
//
// Usage: node tools/ci/spec-citations.mjs [repo-root]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// marked ships with the extension's toolchain. Lexing the markdown, rather than
// matching lines that start with `#`, keeps a comment inside a fenced code
// block from defining an ID.
const require = createRequire(
    join(REPO_ROOT, "src", "editors", "vscode", "node_modules", "/"),
);
const { marked } = require("marked");

/** An ID: a group of two or more characters, then one or more hyphenated parts. */
const ID = /\[([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)\](\(https?:)?/g;

/** How each character moves the parenthesis depth of a heading. */
const PAREN_STEP = new Map([
    ["(", 1],
    [")", -1],
]);

/** Files whose IDs are all EXAMPLES — of the ID format, or this gate's fixtures. */
const EXAMPLE_FILES = new Set([
    ".agents/skills/spec-check/SKILL.md",
    "tools/ci/spec-citations.test.mjs",
]);

/** The ID-format examples the agent instructions use, e.g. `[GROUP-TOPIC]`. */
const PLACEHOLDER_IDS = new Set(["AUTH-TOKEN-VERIFY", "GROUP-TOPIC", "GROUP-TOPIC-DETAIL"]);

/** The ID matches in `text`. A link to an external URL cites nothing. */
function idMatches(text) {
    return [...text.matchAll(ID)].filter((match) => match[2] === undefined);
}

/** The IDs cited in `text`. */
export function idsIn(text) {
    return idMatches(text).map((match) => match[1]);
}

/** How many parentheses are open at `index` of `text`. */
function parenDepth(text, index) {
    return [...text.slice(0, index)].reduce(
        (depth, char) => Math.max(0, depth + (PAREN_STEP.get(char) ?? 0)),
        0,
    );
}

/**
 * The IDs one heading defines: every ID it carries OUTSIDE parentheses.
 * `### CI workflow layout ([DIST-CI-LAYOUT])` only mentions the section it
 * summarises, so a plan cannot keep a deleted spec section alive.
 */
export function definedByHeading(text) {
    return idMatches(text)
        .filter((match) => parenDepth(text, match.index) === 0)
        .map((match) => match[1]);
}

/** Every ID the headings of one markdown document define. */
export function headingIds(markdown) {
    return marked
        .lexer(markdown)
        .filter((token) => token.type === "heading")
        .flatMap((token) => definedByHeading(token.text));
}

/** Every citation in one file, with its 1-based line. */
export function citationsIn(path, text) {
    return text
        .split("\n")
        .flatMap((line, index) => idsIn(line).map((id) => ({ path, line: index + 1, id })));
}

/** True for a spec or plan document, which a citation may name whole. */
function isDocument(path) {
    return /^docs\/(specs|plans)\/[^/]+\.md$/.test(path);
}

/** Every heading definition under `docs/`, with the document holding it. */
export function headingDefinitions(texts) {
    return [...texts]
        .filter(([path]) => path.startsWith("docs/") && path.endsWith(".md"))
        .flatMap(([path, text]) => headingIds(text).map((id) => ({ path, id })));
}

/** Every ID a citation may resolve to. */
function definedIds(texts) {
    const headings = headingDefinitions(texts).map((definition) => definition.id);
    const documents = [...texts.keys()].filter(isDocument).map((path) => basename(path, ".md"));
    return new Set([...headings, ...documents, ...PLACEHOLDER_IDS]);
}

/** The citations nothing defines, in path and line order. */
export function danglingCitations(texts) {
    const defined = definedIds(texts);
    return [...texts]
        .filter(([path]) => !EXAMPLE_FILES.has(path))
        .flatMap(([path, text]) => citationsIn(path, text))
        .filter((citation) => !defined.has(citation.id));
}

/** IDs two headings define: a citation of one cannot say which it means. */
export function duplicateDefinitions(texts) {
    const byId = headingDefinitions(texts).reduce(
        (groups, { path, id }) => groups.set(id, [...(groups.get(id) ?? []), path]),
        new Map(),
    );
    return [...byId]
        .filter(([, paths]) => paths.length > 1)
        .map(([id, paths]) => ({ id, paths }));
}

/** The repository's tracked files, as git names them. */
function trackedFiles(root) {
    const listing = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
    return listing.split("\0").filter((path) => path.length > 0);
}

/** A tracked file's text, or undefined for a binary or one missing on disk. */
function readText(root, path) {
    try {
        const bytes = readFileSync(join(root, path));
        return bytes.includes(0) ? undefined : bytes.toString("utf8");
    } catch {
        return undefined;
    }
}

/** Every tracked text file of `root`, keyed by its repo-relative path. */
export function repositoryTexts(root) {
    return new Map(
        trackedFiles(root)
            .map((path) => [path, readText(root, path)])
            .filter(([, text]) => text !== undefined),
    );
}

/** One line per problem the gate found; empty when every citation resolves. */
export function problems(texts) {
    const dangling = danglingCitations(texts).map(
        ({ path, line, id }) => `${path}:${String(line)}: [${id}] is cited but no heading defines it`,
    );
    const duplicated = duplicateDefinitions(texts).map(
        ({ id, paths }) => `[${id}] is defined by more than one heading: ${paths.join(", ")}`,
    );
    return [...dangling, ...duplicated];
}

function main(root) {
    const found = problems(repositoryTexts(root));
    if (found.length === 0) {
        process.stdout.write("Every spec citation resolves to exactly one definition.\n");
        return;
    }
    process.stderr.write(`${found.join("\n")}\n`);
    process.stderr.write(
        `ERROR: ${String(found.length)} spec citation problem(s). Define the section, cite the ` +
            "section that specifies the behaviour, or parenthesise a heading's mention " +
            "([DIST-CI-SPEC-CITATIONS]).\n",
    );
    process.exit(1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(resolve(process.argv[2] ?? REPO_ROOT));
}
