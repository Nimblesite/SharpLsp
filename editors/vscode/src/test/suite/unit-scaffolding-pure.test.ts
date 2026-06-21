// Pure-logic unit tests for the scaffolding module's testable core.
// These exercise the .NET CLI argument builders, the project-file locator, and
// the new-file content generator WITHOUT spinning up the LSP server or invoking
// any VS Code command — the functions are called directly. Assertion-dense by
// design: every branch of every switch/conditional is pinned to exact output.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  newSolutionArgs,
  newProjectArgs,
  findProjectFile,
  generateFileContent,
} from '../../scaffolding.js';

suite('Scaffolding Pure — newSolutionArgs()', () => {
  test('builds the canonical dotnet new sln argument vector', () => {
    const args = newSolutionArgs('MySolution', '/work/dir');
    assert.deepStrictEqual(args, ['new', 'sln', '--name', 'MySolution', '--output', '/work/dir']);
  });

  test('argument vector always has exactly six elements', () => {
    const args = newSolutionArgs('A', 'B');
    assert.strictEqual(args.length, 6);
  });

  test('first three elements are the fixed command prefix', () => {
    const args = newSolutionArgs('Whatever', '/tmp');
    assert.strictEqual(args[0], 'new');
    assert.strictEqual(args[1], 'sln');
    assert.strictEqual(args[2], '--name');
  });

  test('name is placed immediately after --name', () => {
    const args = newSolutionArgs('Contoso.App', '/repo');
    assert.strictEqual(args[3], 'Contoso.App');
  });

  test('--output flag precedes the folder', () => {
    const args = newSolutionArgs('Sln', '/some/output/folder');
    assert.strictEqual(args[4], '--output');
    assert.strictEqual(args[5], '/some/output/folder');
  });

  test('name and folder are passed through verbatim — not joined or rewritten', () => {
    const args = newSolutionArgs('Name', '/folder');
    // The folder must NOT be combined with the name (unlike project args).
    assert.strictEqual(args[5], '/folder');
    assert.ok(!args[5]?.includes('Name'));
  });

  test('handles names containing spaces without escaping', () => {
    const args = newSolutionArgs('My Solution', '/path with spaces');
    assert.strictEqual(args[3], 'My Solution');
    assert.strictEqual(args[5], '/path with spaces');
  });

  test('handles empty name and empty folder defensively', () => {
    const args = newSolutionArgs('', '');
    assert.deepStrictEqual(args, ['new', 'sln', '--name', '', '--output', '']);
  });

  test('handles unicode names', () => {
    const args = newSolutionArgs('Solución', '/проект');
    assert.strictEqual(args[3], 'Solución');
    assert.strictEqual(args[5], '/проект');
  });

  test('handles regex-special characters in name', () => {
    const args = newSolutionArgs('A.B*C+(D)', '/x');
    assert.strictEqual(args[3], 'A.B*C+(D)');
  });

  test('returns a fresh array on each call (no shared mutable state)', () => {
    const first = newSolutionArgs('X', '/a');
    const second = newSolutionArgs('Y', '/b');
    assert.notStrictEqual(first, second);
    assert.notDeepStrictEqual(first, second);
  });

  test('every element is a string', () => {
    const args = newSolutionArgs('S', '/f');
    for (const element of args) {
      assert.strictEqual(typeof element, 'string');
    }
  });
});

suite('Scaffolding Pure — newProjectArgs()', () => {
  test('builds the canonical dotnet new <template> vector without language', () => {
    const args = newProjectArgs('console', 'MyApp', '/work');
    assert.deepStrictEqual(args, [
      'new',
      'console',
      '--name',
      'MyApp',
      '--output',
      path.join('/work', 'MyApp'),
    ]);
  });

  test('without a language argument the vector has exactly six elements', () => {
    const args = newProjectArgs('classlib', 'Lib', '/repo');
    assert.strictEqual(args.length, 6);
  });

  test('template is placed at index one (right after "new")', () => {
    const args = newProjectArgs('webapi', 'Api', '/repo');
    assert.strictEqual(args[0], 'new');
    assert.strictEqual(args[1], 'webapi');
  });

  test('output path is folder joined with name (project gets its own subdir)', () => {
    const args = newProjectArgs('console', 'Inner', '/outer');
    assert.strictEqual(args[5], path.join('/outer', 'Inner'));
  });

  test('output subdir uses path.join — name appears as the final segment', () => {
    const args = newProjectArgs('worker', 'Svc', '/a/b');
    const output = args[5] ?? '';
    assert.strictEqual(path.basename(output), 'Svc');
    assert.strictEqual(path.dirname(output), path.normalize('/a/b'));
  });

  test('appends --language and the language when lang is provided', () => {
    const args = newProjectArgs('console', 'FApp', '/work', 'F#');
    assert.deepStrictEqual(args, [
      'new',
      'console',
      '--name',
      'FApp',
      '--output',
      path.join('/work', 'FApp'),
      '--language',
      'F#',
    ]);
  });

  test('with a language argument the vector has exactly eight elements', () => {
    const args = newProjectArgs('classlib', 'FLib', '/repo', 'F#');
    assert.strictEqual(args.length, 8);
    assert.strictEqual(args[6], '--language');
    assert.strictEqual(args[7], 'F#');
  });

  test('explicit C# language is still appended (not special-cased away)', () => {
    const args = newProjectArgs('console', 'CApp', '/work', 'C#');
    assert.strictEqual(args.length, 8);
    assert.strictEqual(args[6], '--language');
    assert.strictEqual(args[7], 'C#');
  });

  test('lang of undefined omits the language flag (explicit undefined)', () => {
    const args = newProjectArgs('console', 'App', '/work', undefined);
    assert.strictEqual(args.length, 6);
    assert.ok(!args.includes('--language'));
  });

  test('empty-string lang is treated as a defined value and appended', () => {
    // The guard is `lang !== undefined`, so '' (which is defined) IS appended.
    const args = newProjectArgs('console', 'App', '/work', '');
    assert.strictEqual(args.length, 8);
    assert.strictEqual(args[6], '--language');
    assert.strictEqual(args[7], '');
  });

  test('handles a name with spaces in both name and output segment', () => {
    const args = newProjectArgs('console', 'My App', '/my work');
    assert.strictEqual(args[3], 'My App');
    assert.strictEqual(args[5], path.join('/my work', 'My App'));
  });

  test('handles unicode project names', () => {
    const args = newProjectArgs('classlib', 'Библиотека', '/корень');
    assert.strictEqual(args[3], 'Библиотека');
    assert.strictEqual(args[5], path.join('/корень', 'Библиотека'));
  });

  test('handles dotted project names without altering them', () => {
    const args = newProjectArgs('console', 'Acme.Tools.Cli', '/src');
    assert.strictEqual(args[3], 'Acme.Tools.Cli');
    assert.strictEqual(path.basename(args[5] ?? ''), 'Acme.Tools.Cli');
  });

  test('--name flag always precedes the project name', () => {
    const args = newProjectArgs('xunit', 'Tests', '/repo');
    assert.strictEqual(args[2], '--name');
    assert.strictEqual(args[3], 'Tests');
  });

  test('--output flag always precedes the output directory', () => {
    const args = newProjectArgs('nunit', 'Tests', '/repo');
    assert.strictEqual(args[4], '--output');
  });

  test('different templates flow through to index one verbatim', () => {
    for (const template of ['console', 'classlib', 'webapi', 'blazorserver', 'mstest']) {
      const args = newProjectArgs(template, 'P', '/r');
      assert.strictEqual(args[1], template);
    }
  });

  test('returns a fresh array on each call', () => {
    const first = newProjectArgs('console', 'A', '/a');
    const second = newProjectArgs('console', 'A', '/a', 'F#');
    assert.notStrictEqual(first, second);
    assert.strictEqual(first.length, 6);
    assert.strictEqual(second.length, 8);
  });

  test('every element is a string even with language present', () => {
    const args = newProjectArgs('console', 'P', '/r', 'F#');
    for (const element of args) {
      assert.strictEqual(typeof element, 'string');
    }
  });
});

suite('Scaffolding Pure — findProjectFile()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-find-proj-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('finds a matching .csproj and returns its absolute path', () => {
    const expected = path.join(tmpDir, 'MyApp.csproj');
    fs.writeFileSync(expected, '<Project />', 'utf-8');
    const result = findProjectFile(tmpDir, 'MyApp');
    assert.strictEqual(result, expected);
  });

  test('finds a matching .fsproj when no .csproj exists', () => {
    const expected = path.join(tmpDir, 'MyLib.fsproj');
    fs.writeFileSync(expected, '<Project />', 'utf-8');
    const result = findProjectFile(tmpDir, 'MyLib');
    assert.strictEqual(result, expected);
  });

  test('prefers .csproj over .fsproj when both are present', () => {
    // The loop iterates ['csproj', 'fsproj'] and returns on the first hit.
    const csproj = path.join(tmpDir, 'Dual.csproj');
    const fsproj = path.join(tmpDir, 'Dual.fsproj');
    fs.writeFileSync(csproj, '<Project />', 'utf-8');
    fs.writeFileSync(fsproj, '<Project />', 'utf-8');
    const result = findProjectFile(tmpDir, 'Dual');
    assert.strictEqual(result, csproj);
    assert.notStrictEqual(result, fsproj);
  });

  test('returns undefined when no matching project file exists', () => {
    const result = findProjectFile(tmpDir, 'Missing');
    assert.strictEqual(result, undefined);
  });

  test('returns undefined when the directory is empty', () => {
    const result = findProjectFile(tmpDir, 'Anything');
    assert.strictEqual(result, undefined);
  });

  test('name match is exact — a similarly-named project is not returned', () => {
    fs.writeFileSync(path.join(tmpDir, 'MyApp.Tests.csproj'), '<Project />', 'utf-8');
    const result = findProjectFile(tmpDir, 'MyApp');
    assert.strictEqual(result, undefined);
  });

  test('does not match a file with a non-project extension', () => {
    fs.writeFileSync(path.join(tmpDir, 'Thing.txt'), 'hi', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'Thing.vbproj'), '<Project />', 'utf-8');
    const result = findProjectFile(tmpDir, 'Thing');
    assert.strictEqual(result, undefined);
  });

  test('returns undefined for a non-existent directory without throwing', () => {
    assert.doesNotThrow(() => {
      const result = findProjectFile(path.join(tmpDir, 'no-such-subdir'), 'X');
      assert.strictEqual(result, undefined);
    });
  });

  test('handles dotted project names that match exactly', () => {
    const expected = path.join(tmpDir, 'Acme.Core.csproj');
    fs.writeFileSync(expected, '<Project />', 'utf-8');
    const result = findProjectFile(tmpDir, 'Acme.Core');
    assert.strictEqual(result, expected);
  });

  test('handles names containing spaces', () => {
    const expected = path.join(tmpDir, 'My Project.csproj');
    fs.writeFileSync(expected, '<Project />', 'utf-8');
    const result = findProjectFile(tmpDir, 'My Project');
    assert.strictEqual(result, expected);
  });

  test('handles unicode names', () => {
    const expected = path.join(tmpDir, 'Проект.fsproj');
    fs.writeFileSync(expected, '<Project />', 'utf-8');
    const result = findProjectFile(tmpDir, 'Проект');
    assert.strictEqual(result, expected);
  });

  test('the returned path actually exists on disk', () => {
    const expected = path.join(tmpDir, 'Real.csproj');
    fs.writeFileSync(expected, '<Project />', 'utf-8');
    const result = findProjectFile(tmpDir, 'Real');
    assert.ok(result !== undefined);
    assert.ok(fs.existsSync(result));
  });
});

suite('Scaffolding Pure — generateFileContent()', () => {
  // ── interface ──────────────────────────────────────────────────
  test('interface: exact full content', () => {
    const content = generateFileContent('interface', 'IThing');
    assert.strictEqual(content, 'namespace MyNamespace;\n\npublic interface IThing\n{\n}\n');
  });

  test('interface: declares the interface keyword with the given name', () => {
    const content = generateFileContent('interface', 'IRepository');
    assert.ok(content.includes('public interface IRepository'));
    assert.ok(content.includes('namespace MyNamespace;'));
    assert.ok(content.endsWith('}\n'));
  });

  test('interface: has an open/close brace body', () => {
    const content = generateFileContent('interface', 'IFoo');
    assert.ok(content.includes('{\n}\n'));
  });

  // ── enum ───────────────────────────────────────────────────────
  test('enum: exact full content', () => {
    const content = generateFileContent('enum', 'Color');
    assert.strictEqual(content, 'namespace MyNamespace;\n\npublic enum Color\n{\n}\n');
  });

  test('enum: declares the enum keyword with the given name', () => {
    const content = generateFileContent('enum', 'Status');
    assert.ok(content.includes('public enum Status'));
    assert.ok(!content.includes('class'));
    assert.ok(!content.includes('interface'));
  });

  // ── struct ─────────────────────────────────────────────────────
  test('struct: exact full content', () => {
    const content = generateFileContent('struct', 'Point');
    assert.strictEqual(content, 'namespace MyNamespace;\n\npublic struct Point\n{\n}\n');
  });

  test('struct: declares the struct keyword with the given name', () => {
    const content = generateFileContent('struct', 'Vector3');
    assert.ok(content.includes('public struct Vector3'));
    assert.ok(content.startsWith('namespace MyNamespace;'));
  });

  // ── record ─────────────────────────────────────────────────────
  test('record: exact full content (note: terminated with a semicolon, no body)', () => {
    const content = generateFileContent('record', 'Person');
    assert.strictEqual(content, 'namespace MyNamespace;\n\npublic record Person;\n');
  });

  test('record: is the only type that omits a brace body', () => {
    const content = generateFileContent('record', 'Money');
    assert.ok(content.includes('public record Money;'));
    assert.ok(!content.includes('{\n}\n'));
    assert.ok(content.endsWith(';\n'));
  });

  // ── default / class ────────────────────────────────────────────
  test('class: exact full content (explicit "class" snippet)', () => {
    const content = generateFileContent('class', 'Widget');
    assert.strictEqual(content, 'namespace MyNamespace;\n\npublic class Widget\n{\n}\n');
  });

  test('unknown snippet type falls back to the class template', () => {
    const content = generateFileContent('totally-unknown', 'Fallback');
    assert.strictEqual(content, 'namespace MyNamespace;\n\npublic class Fallback\n{\n}\n');
  });

  test('empty snippet type falls back to the class template', () => {
    const content = generateFileContent('', 'EmptyType');
    assert.strictEqual(content, 'namespace MyNamespace;\n\npublic class EmptyType\n{\n}\n');
  });

  test('snippet type is case-sensitive — "Interface" falls back to class', () => {
    // The switch matches lowercase 'interface'; capitalized hits the default.
    const content = generateFileContent('Interface', 'Cased');
    assert.strictEqual(content, 'namespace MyNamespace;\n\npublic class Cased\n{\n}\n');
    assert.ok(!content.includes('interface'));
  });

  // ── invariants across all supported types ──────────────────────
  test('every supported type begins with the MyNamespace file-scoped namespace', () => {
    for (const type of ['interface', 'enum', 'struct', 'record', 'class', 'other']) {
      const content = generateFileContent(type, 'N');
      assert.ok(
        content.startsWith('namespace MyNamespace;\n\n'),
        `type "${type}" must start with the namespace declaration`,
      );
    }
  });

  test('every supported type is declared public', () => {
    for (const type of ['interface', 'enum', 'struct', 'record', 'class', 'other']) {
      const content = generateFileContent(type, 'N');
      assert.ok(content.includes('public '), `type "${type}" must be public`);
    }
  });

  test('every generated file ends with a trailing newline', () => {
    for (const type of ['interface', 'enum', 'struct', 'record', 'class', 'other']) {
      const content = generateFileContent(type, 'N');
      assert.ok(content.endsWith('\n'), `type "${type}" must end with a newline`);
    }
  });

  test('content does not contain any using/open import directives', () => {
    // The generator emits only a file-scoped namespace; no usings/opens.
    for (const type of ['interface', 'enum', 'struct', 'record', 'class']) {
      const content = generateFileContent(type, 'N');
      assert.ok(!content.includes('using '), `type "${type}" must not emit usings`);
      assert.ok(!content.includes('open '), `type "${type}" must not emit F# opens`);
    }
  });

  test('the keyword maps correctly for each known snippet', () => {
    assert.ok(generateFileContent('interface', 'X').includes('public interface X'));
    assert.ok(generateFileContent('enum', 'X').includes('public enum X'));
    assert.ok(generateFileContent('struct', 'X').includes('public struct X'));
    assert.ok(generateFileContent('record', 'X').includes('public record X;'));
    assert.ok(generateFileContent('class', 'X').includes('public class X'));
  });

  // ── name interpolation edge cases ──────────────────────────────
  test('name is interpolated verbatim including dots', () => {
    const content = generateFileContent('class', 'Acme.Widget');
    assert.ok(content.includes('public class Acme.Widget'));
  });

  test('name with unicode characters is interpolated', () => {
    const content = generateFileContent('interface', 'IОбъект');
    assert.ok(content.includes('public interface IОбъект'));
  });

  test('empty name still produces structurally valid output', () => {
    const content = generateFileContent('class', '');
    assert.strictEqual(content, 'namespace MyNamespace;\n\npublic class \n{\n}\n');
  });

  test('name containing spaces is interpolated literally (no sanitisation)', () => {
    const content = generateFileContent('enum', 'My Enum');
    assert.ok(content.includes('public enum My Enum'));
  });

  test('name with regex-special characters is interpolated literally', () => {
    const content = generateFileContent('struct', 'A$B^C');
    assert.ok(content.includes('public struct A$B^C'));
  });

  test('exactly one occurrence of the name in interface output', () => {
    const content = generateFileContent('interface', 'Unique');
    const occurrences = content.split('Unique').length - 1;
    assert.strictEqual(occurrences, 1);
  });

  test('the namespace is always literally "MyNamespace" regardless of name', () => {
    const content = generateFileContent('class', 'MyNamespace');
    // namespace token + class name both "MyNamespace" → two occurrences total.
    const occurrences = content.split('MyNamespace').length - 1;
    assert.strictEqual(occurrences, 2);
  });
});
