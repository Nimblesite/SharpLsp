// The fix tool edits exactly the ranges the compiler reported: positions map to
// offsets by line and UTF-16 column, and several fixes in one file never shift
// each other. [DIAG-HYGIENE-GUARD]
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
    applyFixes,
    applyTextEdits,
    editsByFile,
    firstDiagnostic,
    offsetOf,
    parenthesiseSoleElement,
    rangesByFile,
} from "./fix-diagnostics.mjs";

const range = (line, start, end, endLine = line) => ({
    start: { line, character: start },
    end: { line: endLine, character: end },
});
const wrap = (text) => `(${text})`;

test("a position maps to its offset by line and column, on any line", () => {
    const text = "let a = 1\nlet bb = [ 1, 2 ]\n\nlast";
    assert.equal(offsetOf(text, { line: 0, character: 0 }), 0);
    assert.equal(offsetOf(text, { line: 0, character: 4 }), 4);
    assert.equal(offsetOf(text, { line: 1, character: 0 }), 10);
    assert.equal(text[offsetOf(text, { line: 1, character: 9 })], "[");
    assert.equal(offsetOf(text, { line: 3, character: 4 }), text.length);
});

test("every reported range is wrapped, in one line and across lines, without shifting the others", () => {
    const text = 'let one = [ "a", 1 ]\nlet two = [ "b", 2 ] @ [ "c", 3 ]\nlet span = [ "d",\n             4 ]\n';
    const fixed = applyFixes(text, [range(0, 12, 18), range(1, 12, 18), range(1, 25, 31), range(2, 13, 14, 3)], wrap);
    assert.equal(
        fixed,
        'let one = [ ("a", 1) ]\nlet two = [ ("b", 2) ] @ [ ("c", 3) ]\nlet span = [ ("d",\n             4) ]\n',
    );
    // Given in any order, the result is the same; with no ranges, the text is untouched.
    assert.equal(applyFixes(text, [range(1, 25, 31), range(0, 12, 18), range(2, 13, 14, 3), range(1, 12, 18)], wrap), fixed);
    assert.equal(applyFixes(text, [], wrap), text);
});

test("ranges are grouped by file for one code, under one path part", () => {
    const item = (code, line) => ({ code, range: range(line, 0, 1) });
    const reports = [
        { uri: pathToFileURL("/repo/tests/A.fs").href, items: [item("FS3886", 1), item("FL0067", 2), item("FS3886", 3)] },
        { uri: pathToFileURL("/repo/src/B.fs").href, items: [item("FS3886", 5)] },
        { uri: pathToFileURL("/repo/tests/Clean.fs").href, items: [] },
        { uri: pathToFileURL("/repo/tests/Unchanged.fs").href, kind: "unchanged" },
    ];
    const all = rangesByFile(reports, "FS3886", "/");
    assert.deepEqual([...all.keys()], ["/repo/tests/A.fs", "/repo/src/B.fs"]);
    assert.deepEqual(all.get("/repo/tests/A.fs").map((found) => found.start.line), [1, 3]);
    assert.deepEqual([...rangesByFile(reports, "FS3886", "/tests/").keys()], ["/repo/tests/A.fs"]);
    assert.equal(rangesByFile(reports, "CS0001", "/").size, 0);
});

test("the sole tuple element is parenthesised inside its brackets, whatever the spacing", () => {
    assert.equal(parenthesiseSoleElement('[ "a", 1 ]'), '[ ("a", 1) ]');
    assert.equal(parenthesiseSoleElement('["a", 1]'), '[("a", 1)]');
    assert.equal(parenthesiseSoleElement('[| "a", 1 |]'), '[| ("a", 1) |]');
    assert.equal(parenthesiseSoleElement("[ -1, $\"{file} was never checked\" ]"), "[ (-1, $\"{file} was never checked\") ]");
    // A list over several lines keeps its continuation aligned under the moved element.
    assert.equal(
        parenthesiseSoleElement('[ "M.fs",\n  "module M\\n"\n  + "let x = 1\\n" ]'),
        '[ ("M.fs",\n   "module M\\n"\n   + "let x = 1\\n") ]',
    );
    // A triple-quoted string across lines may not be re-indented: the list is left for a person.
    const tripleQuoted = '[ "M.fs",\n  """module M\nlet x = 1""" ]';
    assert.equal(parenthesiseSoleElement(tripleQuoted), tripleQuoted);
    assert.equal(parenthesiseSoleElement('[ "M.fs", """one line""" ]'), '[ ("M.fs", """one line""") ]');
});

test("a workspace edit applies in either wire shape, deletions and insertions alike", () => {
    const text = "open System\nopen System.Text\n\nlet a = System.String.Empty\n";
    const edits = [
        { range: range(1, 0, 0, 2), newText: "" },
        { range: range(3, 8, 15), newText: "" },
        { range: range(0, 0, 0), newText: "// header\n" },
    ];
    assert.equal(applyTextEdits(text, edits), "// header\nopen System\n\nlet a = String.Empty\n");
    assert.equal(applyTextEdits(text, []), text);

    const uri = pathToFileURL("/repo/A.fs").href;
    const other = pathToFileURL("/repo/B.cs").href;
    const byChanges = editsByFile({ changes: { [uri]: edits } });
    assert.deepEqual([...byChanges.keys()], ["/repo/A.fs"]);
    assert.equal(byChanges.get("/repo/A.fs").length, 3);
    const byDocuments = editsByFile({
        documentChanges: [{ textDocument: { uri: other, version: null }, edits: [edits[0]] }, { kind: "rename", oldUri: uri, newUri: other }],
    });
    assert.deepEqual([...byDocuments.keys()], ["/repo/B.cs"]);
    assert.equal(editsByFile({}).size, 0);
});

test("the first diagnostic of a code is found with its document, under a path part", () => {
    const item = (code) => ({ code, range: range(0, 0, 1) });
    const reports = [
        { uri: pathToFileURL("/repo/src/A.fs").href, items: [item("FL0067"), item("SLSPF0102")] },
        { uri: pathToFileURL("/repo/tests/B.fs").href, items: [item("SLSPF0102")] },
    ];
    assert.equal(firstDiagnostic(reports, "SLSPF0102", "/").uri, pathToFileURL("/repo/src/A.fs").href);
    assert.equal(firstDiagnostic(reports, "SLSPF0102", "/tests/").uri, pathToFileURL("/repo/tests/B.fs").href);
    assert.equal(firstDiagnostic(reports, "SLSPF0102", "/").item.code, "SLSPF0102");
    assert.equal(firstDiagnostic(reports, "CS0001", "/"), undefined);
});
