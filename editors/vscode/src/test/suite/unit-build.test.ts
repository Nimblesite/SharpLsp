// Pure-logic unit tests for the build module's dotnet argument/diagnostic helpers.
// These exercise the exact CLI argument ordering, shell quoting, tree-node target
// resolution, VS Code task shape, and MSBuild diagnostic parsing. No LSP server,
// no command execution — every function is called directly.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createBuildTask,
  dotnetArgs,
  parseBuildDiagnostics,
  quoteArg,
  targetFromNode,
} from '../../build.js';

suite('Build Module — dotnetArgs()', () => {
  test('plain build yields exactly ["build"]', () => {
    const args = dotnetArgs('build');
    assert.deepStrictEqual(args, ['build']);
    assert.strictEqual(args.length, 1);
    assert.strictEqual(args[0], 'build');
  });

  test('build with target appends the target after the command', () => {
    const args = dotnetArgs('build', 'App.csproj');
    assert.deepStrictEqual(args, ['build', 'App.csproj']);
    assert.strictEqual(args.length, 2);
    assert.strictEqual(args[0], 'build');
    assert.strictEqual(args[1], 'App.csproj');
  });

  test('rebuild maps to the dotnet "build" verb and appends --no-incremental', () => {
    const args = dotnetArgs('rebuild');
    assert.deepStrictEqual(args, ['build', '--no-incremental']);
    assert.strictEqual(args[0], 'build', 'rebuild must not be sent to dotnet verbatim');
    assert.ok(!args.includes('rebuild'), 'the literal "rebuild" verb is never passed to dotnet');
    assert.strictEqual(args[args.length - 1], '--no-incremental');
  });

  test('rebuild with target keeps order: build, target, then --no-incremental', () => {
    const args = dotnetArgs('rebuild', 'Lib.fsproj');
    assert.deepStrictEqual(args, ['build', 'Lib.fsproj', '--no-incremental']);
    assert.strictEqual(args[0], 'build');
    assert.strictEqual(args[1], 'Lib.fsproj');
    assert.strictEqual(args[2], '--no-incremental');
    assert.strictEqual(args.length, 3);
  });

  test('clean yields exactly ["clean"] with no --no-incremental', () => {
    const args = dotnetArgs('clean');
    assert.deepStrictEqual(args, ['clean']);
    assert.ok(!args.includes('--no-incremental'), 'clean is incremental-flag free');
  });

  test('clean with target appends the target and no extra flags', () => {
    const args = dotnetArgs('clean', 'Solution.sln');
    assert.deepStrictEqual(args, ['clean', 'Solution.sln']);
    assert.strictEqual(args.length, 2);
  });

  test('arbitrary verb (restore) passes through unchanged', () => {
    assert.deepStrictEqual(dotnetArgs('restore'), ['restore']);
    assert.deepStrictEqual(dotnetArgs('restore', 'Proj.csproj'), ['restore', 'Proj.csproj']);
  });

  test('only "rebuild" triggers the verb remap — "build" is left intact', () => {
    assert.strictEqual(dotnetArgs('build')[0], 'build');
    assert.strictEqual(dotnetArgs('rebuild')[0], 'build');
    assert.strictEqual(dotnetArgs('clean')[0], 'clean');
  });

  test('only "rebuild" appends --no-incremental — build/clean/restore do not', () => {
    assert.ok(dotnetArgs('rebuild').includes('--no-incremental'));
    assert.ok(!dotnetArgs('build').includes('--no-incremental'));
    assert.ok(!dotnetArgs('clean').includes('--no-incremental'));
    assert.ok(!dotnetArgs('restore').includes('--no-incremental'));
  });

  test('an explicit empty-string target is still pushed (defined !== undefined)', () => {
    const args = dotnetArgs('build', '');
    assert.deepStrictEqual(args, ['build', '']);
    assert.strictEqual(args.length, 2, 'empty string is a defined target, so it is included');
    assert.strictEqual(args[1], '');
  });

  test('empty-string target on rebuild still slots between verb and flag', () => {
    assert.deepStrictEqual(dotnetArgs('rebuild', ''), ['build', '', '--no-incremental']);
  });

  test('target containing spaces is NOT quoted by dotnetArgs (quoting is separate)', () => {
    const args = dotnetArgs('build', 'My App/App.csproj');
    assert.deepStrictEqual(args, ['build', 'My App/App.csproj']);
    assert.ok(!args[1]?.startsWith('"'), 'dotnetArgs does not quote');
  });

  test('returned array is a fresh array each call (no shared mutable state)', () => {
    const first = dotnetArgs('build');
    const second = dotnetArgs('build');
    assert.notStrictEqual(first, second, 'distinct array instances');
    assert.deepStrictEqual(first, second);
    first.push('mutated');
    assert.deepStrictEqual(dotnetArgs('build'), ['build'], 'mutation does not leak');
  });

  test('unknown command behaves like build (no remap, no flag)', () => {
    assert.deepStrictEqual(dotnetArgs('pack'), ['pack']);
    assert.deepStrictEqual(dotnetArgs('pack', 'P.csproj'), ['pack', 'P.csproj']);
  });
});

suite('Build Module — quoteArg()', () => {
  test('value with no whitespace is returned verbatim', () => {
    assert.strictEqual(quoteArg('Project.csproj'), 'Project.csproj');
  });

  test('value containing a single space is wrapped in double quotes', () => {
    assert.strictEqual(quoteArg('My Project.csproj'), '"My Project.csproj"');
  });

  test('value with multiple spaces is wrapped once around the whole value', () => {
    assert.strictEqual(quoteArg('a b c'), '"a b c"');
  });

  test('empty string contains no space and is returned unchanged', () => {
    assert.strictEqual(quoteArg(''), '');
  });

  test('a single space character becomes a quoted single space', () => {
    assert.strictEqual(quoteArg(' '), '" "');
  });

  test('leading space triggers quoting', () => {
    assert.strictEqual(quoteArg(' leading'), '" leading"');
  });

  test('trailing space triggers quoting', () => {
    assert.strictEqual(quoteArg('trailing '), '"trailing "');
  });

  test('already-double-quoted value WITHOUT a space is left as-is (not re-wrapped)', () => {
    assert.strictEqual(quoteArg('"quoted"'), '"quoted"');
  });

  test('value with an embedded quote AND a space gets wrapped (quotes not escaped)', () => {
    assert.strictEqual(quoteArg('has"quote and space'), '"has"quote and space"');
  });

  test('tab character does not count as a space — not quoted', () => {
    assert.strictEqual(quoteArg('a\tb'), 'a\tb');
  });

  test('newline does not count as a space — not quoted', () => {
    assert.strictEqual(quoteArg('a\nb'), 'a\nb');
  });

  test('unicode non-breaking space (U+00A0) is not the ASCII space — not quoted', () => {
    const nbsp = 'a b';
    assert.strictEqual(quoteArg(nbsp), nbsp);
    assert.ok(!quoteArg(nbsp).startsWith('"'));
  });

  test('regex-special characters with no space pass through untouched', () => {
    assert.strictEqual(quoteArg('a.*+?[](){}|^$\\b'), 'a.*+?[](){}|^$\\b');
  });

  test('regex-special characters WITH a space get wrapped literally', () => {
    assert.strictEqual(quoteArg('a .*+?$ b'), '"a .*+?$ b"');
  });

  test('a real-world path with a space in a folder name is quoted', () => {
    assert.strictEqual(
      quoteArg('/Users/dev/My Solutions/App.csproj'),
      '"/Users/dev/My Solutions/App.csproj"',
    );
  });
});

suite('Build Module — targetFromNode()', () => {
  test('undefined node resolves to undefined target', () => {
    assert.strictEqual(targetFromNode(undefined), undefined);
  });

  test('node with no projectFilePath resolves to undefined', () => {
    assert.strictEqual(targetFromNode({}), undefined);
  });

  test('node with empty-string projectFilePath resolves to undefined (length 0 guard)', () => {
    assert.strictEqual(targetFromNode({ projectFilePath: '' }), undefined);
  });

  test('node with a real path returns that exact path', () => {
    assert.strictEqual(
      targetFromNode({ projectFilePath: '/repo/src/App.csproj' }),
      '/repo/src/App.csproj',
    );
  });

  test('node with a single-character path is considered present (length > 0)', () => {
    assert.strictEqual(targetFromNode({ projectFilePath: 'x' }), 'x');
  });

  test('a path containing spaces is returned unmodified (quoting is a later step)', () => {
    const p = '/My Projects/Foo.fsproj';
    assert.strictEqual(targetFromNode({ projectFilePath: p }), p);
  });

  test('a whitespace-only path has length > 0 and is returned as-is', () => {
    assert.strictEqual(targetFromNode({ projectFilePath: '   ' }), '   ');
  });
});

suite('Build Module — createBuildTask()', () => {
  test('task name equals the supplied label and source is "SharpLsp"', () => {
    const task = createBuildTask('build', 'Build');
    assert.strictEqual(task.name, 'Build');
    assert.strictEqual(task.source, 'SharpLsp');
  });

  test('task definition carries the provider type and the raw command', () => {
    const task = createBuildTask('rebuild', 'Rebuild');
    assert.strictEqual(task.definition.type, 'sharplsp-build');
    assert.strictEqual(task.definition.command, 'rebuild');
  });

  test('task belongs to the Build task group', () => {
    const task = createBuildTask('clean', 'Clean');
    assert.strictEqual(task.group, vscode.TaskGroup.Build);
    assert.strictEqual(task.group?.id, vscode.TaskGroup.Build.id);
  });

  test('execution is a ShellExecution invoking the dotnet command', () => {
    const task = createBuildTask('build', 'Build');
    assert.ok(task.execution instanceof vscode.ShellExecution);
    const exec = task.execution;
    assert.strictEqual(exec.command, 'dotnet');
  });

  test('execution args for "build" match dotnetArgs("build") (no target)', () => {
    const task = createBuildTask('build', 'Build');
    const exec = task.execution as vscode.ShellExecution;
    assert.deepStrictEqual(exec.args, ['build']);
  });

  test('execution args for "rebuild" remap the verb and add --no-incremental', () => {
    const task = createBuildTask('rebuild', 'Rebuild');
    const exec = task.execution as vscode.ShellExecution;
    assert.deepStrictEqual(exec.args, ['build', '--no-incremental']);
  });

  test('execution args for "clean" are exactly ["clean"]', () => {
    const task = createBuildTask('clean', 'Clean');
    const exec = task.execution as vscode.ShellExecution;
    assert.deepStrictEqual(exec.args, ['clean']);
  });

  test('the $msCompile problem matcher is attached', () => {
    const task = createBuildTask('build', 'Build');
    assert.ok(task.problemMatchers.includes('$msCompile'));
  });

  test('label and command are independent — label is display, command drives args', () => {
    const task = createBuildTask('clean', 'Custom Clean Label');
    assert.strictEqual(task.name, 'Custom Clean Label');
    assert.strictEqual(task.definition.command, 'clean');
    const exec = task.execution as vscode.ShellExecution;
    assert.deepStrictEqual(exec.args, ['clean']);
  });

  test('each call produces a distinct Task instance', () => {
    const a = createBuildTask('build', 'Build');
    const b = createBuildTask('build', 'Build');
    assert.notStrictEqual(a, b);
    assert.strictEqual(a.name, b.name);
  });
});

suite('Build Module — parseBuildDiagnostics()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-build-diag-'));
  });

  teardown(() => {
    // Clearing the module-private collection so tests do not leak diagnostics.
    parseBuildDiagnostics('');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fixturePath(name: string): string {
    return path.join(tmpDir, name);
  }

  test('a single error line produces one Error diagnostic on the right URI', () => {
    const file = fixturePath('Program.cs');
    parseBuildDiagnostics(`${file}(10,5): error CS1002: ; expected`);
    const diags = vscode.languages.getDiagnostics(vscode.Uri.file(file));
    assert.strictEqual(diags.length, 1);
    const diag = diags[0];
    assert.ok(diag !== undefined);
    assert.strictEqual(diag.severity, vscode.DiagnosticSeverity.Error);
    assert.strictEqual(diag.message, 'CS1002: ; expected');
    assert.strictEqual(diag.source, 'dotnet build');
  });

  test('line/column are converted from 1-based MSBuild to 0-based VS Code', () => {
    const file = fixturePath('Convert.cs');
    parseBuildDiagnostics(`${file}(10,5): error CS1002: ; expected`);
    const diag = vscode.languages.getDiagnostics(vscode.Uri.file(file))[0];
    assert.ok(diag !== undefined);
    assert.strictEqual(diag.range.start.line, 9);
    assert.strictEqual(diag.range.start.character, 4);
    assert.strictEqual(diag.range.end.line, 9);
    assert.strictEqual(diag.range.end.character, 4);
    assert.ok(diag.range.isEmpty, 'diagnostic range is a zero-width caret');
  });

  test('a warning line produces a Warning-severity diagnostic', () => {
    const file = fixturePath('Warn.cs');
    parseBuildDiagnostics(`${file}(3,1): warning CS0168: variable declared but never used`);
    const diag = vscode.languages.getDiagnostics(vscode.Uri.file(file))[0];
    assert.ok(diag !== undefined);
    assert.strictEqual(diag.severity, vscode.DiagnosticSeverity.Warning);
    assert.strictEqual(diag.message, 'CS0168: variable declared but never used');
    assert.strictEqual(diag.range.start.line, 2);
    assert.strictEqual(diag.range.start.character, 0);
  });

  test('multiple diagnostics on the same file are grouped under one URI', () => {
    const file = fixturePath('Multi.cs');
    const output = [
      `${file}(1,1): error CS0001: first`,
      `${file}(2,2): warning CS0002: second`,
      `${file}(3,3): error CS0003: third`,
    ].join('\n');
    parseBuildDiagnostics(output);
    const diags = vscode.languages.getDiagnostics(vscode.Uri.file(file));
    assert.strictEqual(diags.length, 3);
    assert.strictEqual(diags[0]?.message, 'CS0001: first');
    assert.strictEqual(diags[1]?.message, 'CS0002: second');
    assert.strictEqual(diags[2]?.message, 'CS0003: third');
    const errorCount = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
    const warnCount = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;
    assert.strictEqual(errorCount, 2);
    assert.strictEqual(warnCount, 1);
  });

  test('diagnostics across different files land on their respective URIs', () => {
    const fileA = fixturePath('A.cs');
    const fileB = fixturePath('B.cs');
    parseBuildDiagnostics(
      `${fileA}(5,5): error CS1001: in A\n${fileB}(6,6): warning CS1002: in B`,
    );
    const aDiags = vscode.languages.getDiagnostics(vscode.Uri.file(fileA));
    const bDiags = vscode.languages.getDiagnostics(vscode.Uri.file(fileB));
    assert.strictEqual(aDiags.length, 1);
    assert.strictEqual(bDiags.length, 1);
    assert.strictEqual(aDiags[0]?.message, 'CS1001: in A');
    assert.strictEqual(bDiags[0]?.message, 'CS1002: in B');
    assert.strictEqual(aDiags[0]?.severity, vscode.DiagnosticSeverity.Error);
    assert.strictEqual(bDiags[0]?.severity, vscode.DiagnosticSeverity.Warning);
  });

  test('non-diagnostic lines (build banners, info) are ignored', () => {
    const file = fixturePath('Quiet.cs');
    const output = [
      'Microsoft (R) Build Engine version 17.0',
      'Determining projects to restore...',
      `${file}(7,2): error CS9999: only this matters`,
      'Build FAILED.',
      '    1 Error(s)',
    ].join('\n');
    parseBuildDiagnostics(output);
    const diags = vscode.languages.getDiagnostics(vscode.Uri.file(file));
    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0]?.message, 'CS9999: only this matters');
  });

  test('clears previously published diagnostics on each call', () => {
    const file = fixturePath('Cleared.cs');
    parseBuildDiagnostics(`${file}(1,1): error CS0001: stale`);
    assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(file)).length, 1);
    // A subsequent parse with no matching diagnostics must wipe the previous set.
    parseBuildDiagnostics('Build succeeded.\n    0 Warning(s)\n    0 Error(s)');
    assert.strictEqual(
      vscode.languages.getDiagnostics(vscode.Uri.file(file)).length,
      0,
      'previous diagnostics are cleared when none are parsed',
    );
  });

  test('empty output clears the collection and produces no diagnostics', () => {
    const file = fixturePath('Empty.cs');
    parseBuildDiagnostics(`${file}(2,2): warning CS0100: pre-existing`);
    assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(file)).length, 1);
    parseBuildDiagnostics('');
    assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(file)).length, 0);
  });

  test('lines missing the "error"/"warning" keyword do not match', () => {
    const file = fixturePath('NoSeverity.cs');
    // "note" is not a recognized severity, so the line is skipped.
    parseBuildDiagnostics(`${file}(1,1): note CS0001: not a diagnostic`);
    assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(file)).length, 0);
  });

  test('lines without a (line,col) location do not match', () => {
    const file = fixturePath('NoLocation.cs');
    parseBuildDiagnostics(`${file}: error CS0001: missing location`);
    assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(file)).length, 0);
  });

  test('a message containing colons is captured in full', () => {
    const file = fixturePath('Colons.cs');
    parseBuildDiagnostics(`${file}(4,8): error CS0246: type 'Foo: Bar' not found: check using`);
    const diag = vscode.languages.getDiagnostics(vscode.Uri.file(file))[0];
    assert.ok(diag !== undefined);
    assert.strictEqual(diag.message, "CS0246: type 'Foo: Bar' not found: check using");
  });

  test('higher line/column numbers are parsed and decremented correctly', () => {
    const file = fixturePath('Big.cs');
    parseBuildDiagnostics(`${file}(1234,567): error CS1234: deep`);
    const diag = vscode.languages.getDiagnostics(vscode.Uri.file(file))[0];
    assert.ok(diag !== undefined);
    assert.strictEqual(diag.range.start.line, 1233);
    assert.strictEqual(diag.range.start.character, 566);
  });

  test('column 1 maps to character 0 (boundary)', () => {
    const file = fixturePath('Boundary.cs');
    parseBuildDiagnostics(`${file}(1,1): error CS0000: top of file`);
    const diag = vscode.languages.getDiagnostics(vscode.Uri.file(file))[0];
    assert.ok(diag !== undefined);
    assert.strictEqual(diag.range.start.line, 0);
    assert.strictEqual(diag.range.start.character, 0);
  });

  test('the diagnostic message prefixes the code then a colon and space', () => {
    const file = fixturePath('Format.cs');
    parseBuildDiagnostics(`${file}(2,3): warning IDE0051: member is unused`);
    const diag = vscode.languages.getDiagnostics(vscode.Uri.file(file))[0];
    assert.ok(diag !== undefined);
    assert.strictEqual(diag.message, 'IDE0051: member is unused');
    assert.ok(diag.message.startsWith('IDE0051: '));
  });
});
