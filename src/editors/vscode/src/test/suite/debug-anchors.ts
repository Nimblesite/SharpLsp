// Line addressing for the step-through debugging fixtures.
//
// Spec: [DEBUG-FEATURES-BREAKPOINTS], [DEBUG-FEATURES-STEPPING].
//
// A stepping test is a statement about LINES: "F10 on the call line lands on
// the next statement, not inside the callee". Writing those line numbers as
// integers makes every test in the suite wrong the moment a fixture gains a
// `using` directive, so each interesting statement carries a trailing
// `// @anchor:<name>` comment — a real comment in a real compiled program — and
// tests address lines by name.
//
// Two numbering systems meet here and are NOT interchangeable:
//
//   * `vscode.Position.line` is 0-based. `SourceBreakpoint` takes one.
//   * DAP `Source`/`StackFrame`/`Breakpoint` lines are 1-based, because VS Code
//     sends `linesStartAt1: true` in `initialize`.
//
// Confusing the two is an off-by-one that still "passes" whenever a fixture
// happens to have adjacent statements, so the two are separate accessors with
// separate names and neither is ever derived from the other at a call site.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

/** The marker that makes a fixture line addressable. Valid in C# and in F#. */
export const ANCHOR_MARKER = '// @anchor:';

/** A fixture program whose interesting statements are addressable by name. */
export class AnchoredSource {
  private readonly anchors: ReadonlyMap<string, number>;

  /** The program text, newline-joined and newline-terminated. */
  public readonly text: string;

  public constructor(lines: readonly string[]) {
    this.text = `${lines.join('\n')}\n`;
    this.anchors = indexAnchors(lines);
  }

  /** 0-based line index — what `vscode.Position` and `SourceBreakpoint` want. */
  public line(anchor: string): number {
    const index = this.anchors.get(anchor);
    if (index === undefined) {
      assert.fail(`unknown fixture anchor '${anchor}'; declared: ${this.names().join(', ')}`);
    }
    return index;
  }

  /** 1-based line number — what every DAP response reports. */
  public dapLine(anchor: string): number {
    return this.line(anchor) + 1;
  }

  /** The start-of-line position for `anchor`, for a `SourceBreakpoint`. */
  public position(anchor: string): vscode.Position {
    return new vscode.Position(this.line(anchor), 0);
  }

  /** The source text of `anchor`'s line, trailing anchor comment included. */
  public code(anchor: string): string {
    return this.text.split('\n')[this.line(anchor)] ?? '';
  }

  /** Every declared anchor, sorted — the diagnosable set on a lookup miss. */
  public names(): string[] {
    return [...this.anchors.keys()].sort();
  }
}

/**
 * Map each `// @anchor:<name>` comment to its 0-based line index.
 *
 * A duplicated anchor is a fixture bug that would silently make one of the two
 * tests using it assert against the other's line, so it fails at construction.
 */
function indexAnchors(lines: readonly string[]): ReadonlyMap<string, number> {
  const anchors = new Map<string, number>();
  lines.forEach((line, index) => {
    const marker = line.lastIndexOf(ANCHOR_MARKER);
    if (marker < 0) return;
    const name = line.slice(marker + ANCHOR_MARKER.length).trim();
    assert.strictEqual(anchors.has(name), false, `fixture anchor '${name}' is declared twice`);
    assert.notStrictEqual(name, '', `an empty anchor name on line ${String(index + 1)}`);
    anchors.set(name, index);
  });
  return anchors;
}
