// Pure-logic unit tests for the build module's dotnet argument/diagnostic helpers.
// These exercise the exact CLI argument ordering, shell quoting, tree-node target
// resolution, VS Code task shape, and MSBuild diagnostic parsing. No LSP server,
// no command execution — every function is called directly.
import * as assert from 'node:assert/strict';
import * as childProcess from 'child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildWithDiagnostics,
  createBuildTask,
  dotnetArgs,
  parseBuildDiagnostics,
  quoteArg,
  targetFromNode,
  SharpLspBuildTaskProvider,
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
    parseBuildDiagnostics(`${fileA}(5,5): error CS1001: in A\n${fileB}(6,6): warning CS1002: in B`);
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

  test('a real "dotnet build" error line with a trailing [proj.csproj] suffix is parsed', () => {
    // The trailing ` [path.csproj]` is captured into the message because the
    // message group is greedy `(.+)$` — assert that exact string round-trips.
    const file = fixturePath('Suffixed.cs');
    parseBuildDiagnostics(
      `${file}(12,5): error CS1002: ; expected [${fixturePath('proj.csproj')}]`,
    );
    const diags = vscode.languages.getDiagnostics(vscode.Uri.file(file));
    assert.strictEqual(diags.length, 1);
    const diag = diags[0];
    assert.ok(diag !== undefined);
    assert.strictEqual(diag.severity, vscode.DiagnosticSeverity.Error);
    assert.strictEqual(diag.message, `CS1002: ; expected [${fixturePath('proj.csproj')}]`);
    assert.strictEqual(diag.range.start.line, 11);
    assert.strictEqual(diag.range.start.character, 4);
  });

  test('a real "dotnet build" warning line with a project suffix is parsed', () => {
    const file = fixturePath('WarnSuffixed.cs');
    const proj = fixturePath('Lib.csproj');
    parseBuildDiagnostics(
      `${file}(8,13): warning CS0219: The variable 'x' is assigned but its value is never used [${proj}]`,
    );
    const diag = vscode.languages.getDiagnostics(vscode.Uri.file(file))[0];
    assert.ok(diag !== undefined);
    assert.strictEqual(diag.severity, vscode.DiagnosticSeverity.Warning);
    assert.strictEqual(
      diag.message,
      `CS0219: The variable 'x' is assigned but its value is never used [${proj}]`,
    );
  });

  test('mixed error + warning + non-matching lines across two files (full pipeline)', () => {
    const fileA = fixturePath('Pipeline_A.cs');
    const fileB = fixturePath('Pipeline_B.fs');
    const output = [
      'Determining projects to restore...',
      '  Restored /repo/App.csproj (in 120 ms).',
      `${fileA}(1,1): error CS1002: ; expected [${fixturePath('A.csproj')}]`,
      `${fileA}(2,2): warning CS0168: variable declared but never used [${fixturePath('A.csproj')}]`,
      'Build FAILED.',
      `${fileB}(10,4): error FS0039: not defined [${fixturePath('B.fsproj')}]`,
      '    2 Error(s)',
      '    1 Warning(s)',
    ].join('\n');
    parseBuildDiagnostics(output);
    const aDiags = vscode.languages.getDiagnostics(vscode.Uri.file(fileA));
    const bDiags = vscode.languages.getDiagnostics(vscode.Uri.file(fileB));
    assert.strictEqual(aDiags.length, 2, 'file A gets one error and one warning');
    assert.strictEqual(bDiags.length, 1, 'file B gets one error');
    assert.strictEqual(aDiags[0]?.severity, vscode.DiagnosticSeverity.Error);
    assert.strictEqual(aDiags[1]?.severity, vscode.DiagnosticSeverity.Warning);
    assert.strictEqual(bDiags[0]?.severity, vscode.DiagnosticSeverity.Error);
    assert.ok(bDiags[0]?.message.startsWith('FS0039: '));
  });

  test('output containing zero matching diagnostic lines yields an empty collection', () => {
    const file = fixturePath('AllNoise.cs');
    // Seed one diagnostic, then a pure-noise parse must wipe it.
    parseBuildDiagnostics(`${file}(1,1): error CS0001: seed`);
    assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(file)).length, 1);
    parseBuildDiagnostics(
      ['Microsoft (R) Build Engine', 'Time Elapsed 00:00:01.23', 'Build succeeded.'].join('\n'),
    );
    assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(file)).length, 0);
  });

  test('an F#-style FS diagnostic code is parsed identically to a CS code', () => {
    const file = fixturePath('FSharp.fs');
    parseBuildDiagnostics(`${file}(5,7): error FS0001: This expression was expected to have type`);
    const diag = vscode.languages.getDiagnostics(vscode.Uri.file(file))[0];
    assert.ok(diag !== undefined);
    assert.strictEqual(diag.message, 'FS0001: This expression was expected to have type');
    assert.strictEqual(diag.range.start.line, 4);
    assert.strictEqual(diag.range.start.character, 6);
  });
});

suite('Build Module — SharpLspBuildTaskProvider', () => {
  test('static Type identifier is the stable provider id "sharplsp-build"', () => {
    assert.strictEqual(SharpLspBuildTaskProvider.Type, 'sharplsp-build');
  });

  test('provideTasks returns exactly the build, rebuild and clean tasks', () => {
    const provider = new SharpLspBuildTaskProvider();
    const tasks = provider.provideTasks();
    assert.strictEqual(tasks.length, 3);
    assert.deepStrictEqual(
      tasks.map((t) => t.name),
      ['Build', 'Rebuild', 'Clean'],
    );
    assert.deepStrictEqual(
      tasks.map((t) => String(t.definition.command)),
      ['build', 'rebuild', 'clean'],
    );
  });

  test('every provided task is a Build-group dotnet ShellExecution', () => {
    const provider = new SharpLspBuildTaskProvider();
    for (const task of provider.provideTasks()) {
      assert.strictEqual(task.source, 'SharpLsp');
      assert.strictEqual(task.group, vscode.TaskGroup.Build);
      assert.strictEqual(task.definition.type, 'sharplsp-build');
      assert.ok(task.execution instanceof vscode.ShellExecution);
      const exec = task.execution;
      assert.strictEqual(exec.command, 'dotnet');
      assert.ok(task.problemMatchers.includes('$msCompile'));
    }
  });

  test('provided rebuild task carries the --no-incremental remapped args', () => {
    const provider = new SharpLspBuildTaskProvider();
    const rebuild = provider.provideTasks().find((t) => t.name === 'Rebuild');
    assert.ok(rebuild !== undefined);
    const exec = rebuild.execution as vscode.ShellExecution;
    assert.deepStrictEqual(exec.args, ['build', '--no-incremental']);
  });

  function definedTask(command: string, name: string): vscode.Task {
    return new vscode.Task(
      { type: SharpLspBuildTaskProvider.Type, command },
      vscode.TaskScope.Workspace,
      name,
      'SharpLsp',
    );
  }

  test('resolveTask rebuilds a task from its definition.command', () => {
    const provider = new SharpLspBuildTaskProvider();
    const resolved = provider.resolveTask(definedTask('build', 'My Build'));
    assert.ok(resolved !== undefined);
    assert.strictEqual(resolved.name, 'My Build');
    assert.strictEqual(resolved.definition.command, 'build');
    const exec = resolved.execution as vscode.ShellExecution;
    assert.deepStrictEqual(exec.args, ['build']);
    assert.strictEqual(resolved.group, vscode.TaskGroup.Build);
  });

  test('resolveTask honours the clean command and uses the task name as the label', () => {
    const provider = new SharpLspBuildTaskProvider();
    const resolved = provider.resolveTask(definedTask('clean', 'Tidy Up'));
    assert.ok(resolved !== undefined);
    assert.strictEqual(resolved.name, 'Tidy Up');
    assert.strictEqual(resolved.definition.command, 'clean');
    const exec = resolved.execution as vscode.ShellExecution;
    assert.deepStrictEqual(exec.args, ['clean']);
  });

  test('resolveTask remaps a rebuild definition to build --no-incremental', () => {
    const provider = new SharpLspBuildTaskProvider();
    const resolved = provider.resolveTask(definedTask('rebuild', 'Force Rebuild'));
    assert.ok(resolved !== undefined);
    const exec = resolved.execution as vscode.ShellExecution;
    assert.deepStrictEqual(exec.args, ['build', '--no-incremental']);
  });

  test('resolveTask returns undefined when definition.command is missing', () => {
    const provider = new SharpLspBuildTaskProvider();
    const task = new vscode.Task(
      { type: SharpLspBuildTaskProvider.Type },
      vscode.TaskScope.Workspace,
      'No Command',
      'SharpLsp',
    );
    assert.strictEqual(provider.resolveTask(task), undefined);
  });

  test('resolveTask returns undefined when definition.command is an empty string', () => {
    const provider = new SharpLspBuildTaskProvider();
    assert.strictEqual(provider.resolveTask(definedTask('', 'Empty')), undefined);
  });

  test('each provider instance is independent and re-creates fresh task arrays', () => {
    const provider = new SharpLspBuildTaskProvider();
    const first = provider.provideTasks();
    const second = provider.provideTasks();
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first[0], second[0]);
    assert.deepStrictEqual(
      first.map((t) => t.name),
      second.map((t) => t.name),
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Build Module — buildWithDiagnostics()
//
// buildWithDiagnostics spawns `dotnet` via child_process.execFile. We replace
// that seam (the same `child_process` module object the built `out/build.js`
// requires) with a synchronous fake so no real `dotnet` process ever runs. This
// exercises the resolve-on-output path, the reject-on-empty-error path, and the
// surrounding catch — all without leaving the test host.
// ─────────────────────────────────────────────────────────────────

type ExecFileCallback = (
  error: childProcess.ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

interface MutableChildProcess {
  execFile: typeof childProcess.execFile;
}

// `out/build.js` calls `(0, child_process_1.execFile)(...)` — i.e. it reads
// `execFile` off the *raw* `require('child_process')` singleton at call time.
// A `import * as childProcess` namespace is an `__importStar` wrapper whose
// `execFile` is a getter (assigning to it throws), and it is NOT the object
// build.js reads. Resolving the raw module via `createRequire` gives the exact
// singleton both this test and build.js share, so patching its `execFile`
// intercepts the spawn.
const rawChildProcess = createRequire(__filename)('child_process') as MutableChildProcess;

interface FakeExecResult {
  readonly error: childProcess.ExecFileException | null;
  readonly stdout: string;
  readonly stderr: string;
}

suite('Build Module — buildWithDiagnostics()', () => {
  const mut = rawChildProcess;
  let origExecFile: typeof childProcess.execFile;
  let captured: { file: string; args: readonly string[]; cwd: string | undefined } | undefined;

  setup(() => {
    origExecFile = mut.execFile;
    captured = undefined;
  });

  teardown(() => {
    // ALWAYS restore the real execFile so no later suite spawns into the fake.
    mut.execFile = origExecFile;
    // Drop any diagnostics the fake build produced.
    parseBuildDiagnostics('');
  });

  /** Install a synchronous fake execFile that invokes the callback with `result`. */
  function stubExecFile(result: FakeExecResult): void {
    mut.execFile = ((
      file: string,
      args: readonly string[],
      options: { cwd?: string },
      callback: ExecFileCallback,
    ) => {
      captured = { file, args, cwd: options.cwd };
      callback(result.error, result.stdout, result.stderr);
      return undefined;
    }) as unknown as typeof childProcess.execFile;
  }

  function workspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  test('invokes dotnet with the build args in the workspace folder', async () => {
    const folder = workspaceFolder();
    assert.ok(folder !== undefined, 'the test host provides a workspace folder');
    stubExecFile({ error: null, stdout: '', stderr: '' });

    await buildWithDiagnostics('build');

    assert.ok(captured !== undefined, 'execFile must be invoked');
    assert.strictEqual(captured.file, 'dotnet');
    assert.deepStrictEqual([...captured.args], ['build']);
    assert.strictEqual(captured.cwd, folder, 'spawn runs in the workspace folder');
  });

  test('passes the target through to dotnet build args', async () => {
    stubExecFile({ error: null, stdout: '', stderr: '' });
    await buildWithDiagnostics('build', 'App.csproj');
    assert.ok(captured !== undefined);
    assert.deepStrictEqual([...captured.args], ['build', 'App.csproj']);
  });

  test('rebuild forwards the remapped --no-incremental args', async () => {
    stubExecFile({ error: null, stdout: '', stderr: '' });
    await buildWithDiagnostics('rebuild', 'Lib.fsproj');
    assert.ok(captured !== undefined);
    assert.deepStrictEqual([...captured.args], ['build', 'Lib.fsproj', '--no-incremental']);
  });

  test('parses diagnostics from a successful build that produced compiler output', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-bwd-ok-'));
    try {
      const file = path.join(tmpDir, 'Ok.cs');
      stubExecFile({
        error: null,
        stdout: `${file}(4,2): warning CS0168: unused`,
        stderr: '',
      });

      await buildWithDiagnostics('build');

      const diags = vscode.languages.getDiagnostics(vscode.Uri.file(file));
      assert.strictEqual(diags.length, 1, 'stdout diagnostics are parsed and published');
      assert.strictEqual(diags[0]?.message, 'CS0168: unused');
      assert.strictEqual(diags[0]?.severity, vscode.DiagnosticSeverity.Warning);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('a non-zero exit that still emits output resolves and parses (not rejected)', async () => {
    // The build "fails" with an error object, but because stdout is non-empty
    // the promise resolves (line 98 guard false) and the output is parsed.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-bwd-fail-'));
    try {
      const file = path.join(tmpDir, 'Fail.cs');
      const exitError = Object.assign(new Error('build exited 1'), {
        code: 1,
      }) as childProcess.ExecFileException;
      stubExecFile({
        error: exitError,
        stdout: `${file}(1,1): error CS1002: ; expected`,
        stderr: '',
      });

      await buildWithDiagnostics('build');

      const diags = vscode.languages.getDiagnostics(vscode.Uri.file(file));
      assert.strictEqual(diags.length, 1, 'output is parsed despite the non-zero exit');
      assert.strictEqual(diags[0]?.severity, vscode.DiagnosticSeverity.Error);
      assert.strictEqual(diags[0]?.message, 'CS1002: ; expected');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('stderr-only output (no error) is concatenated and parsed', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-bwd-stderr-'));
    try {
      const file = path.join(tmpDir, 'Err.fs');
      stubExecFile({
        error: null,
        stdout: '',
        stderr: `${file}(2,3): error FS0001: type mismatch`,
      });

      await buildWithDiagnostics('build');

      const diags = vscode.languages.getDiagnostics(vscode.Uri.file(file));
      assert.strictEqual(diags.length, 1, 'stderr output is parsed too (stdout + "\\n" + stderr)');
      assert.strictEqual(diags[0]?.message, 'FS0001: type mismatch');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('an error with empty stdout AND stderr rejects, and the catch swallows it', async () => {
    // error set, stdout '' and stderr '' -> reject(new Error(...)) (lines 99-100)
    // -> caught and logged (lines 105-107). buildWithDiagnostics must still
    // resolve (never throw) so the command handler does not surface a failure.
    const spawnError = Object.assign(new Error('dotnet not found'), {
      code: 'ENOENT',
    }) as childProcess.ExecFileException;
    stubExecFile({ error: spawnError, stdout: '', stderr: '' });

    await assert.doesNotReject(async () => {
      await buildWithDiagnostics('build');
    }, 'a hard spawn failure is caught and never propagates out of buildWithDiagnostics');

    assert.ok(captured !== undefined, 'the spawn was attempted before failing');
  });

  test('whitespace-only stdout/stderr around an error is NOT empty, so it resolves', async () => {
    // stdout '\n' has length > 0, so the reject guard (stdout.length === 0) is
    // false and the promise resolves with concatenated (non-diagnostic) output.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-bwd-ws-'));
    try {
      const file = path.join(tmpDir, 'Seed.cs');
      // Seed a diagnostic, then a resolve with no matching lines must clear it.
      parseBuildDiagnostics(`${file}(1,1): error CS0001: seed`);
      assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(file)).length, 1);

      const exitError = Object.assign(new Error('exit 1'), {
        code: 1,
      }) as childProcess.ExecFileException;
      stubExecFile({ error: exitError, stdout: '\n', stderr: '' });

      await assert.doesNotReject(async () => {
        await buildWithDiagnostics('build');
      });

      assert.strictEqual(
        vscode.languages.getDiagnostics(vscode.Uri.file(file)).length,
        0,
        'resolving with non-diagnostic output clears the seeded diagnostic',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
