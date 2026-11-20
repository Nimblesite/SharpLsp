// The language of the project that built a test assembly decides its Testing
// view tag (#604): real project folders, one per case — a C# test named like a
// property test, an F# Expecto list path, a listing that names its project, and
// an assembly no project owns.
//
// Covers [TEST-EXPLORER].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectLanguageOf } from '../../test-language.js';

suite("Test Explorer — a test row's language comes from its project (#604)", () => {
  test('C#, F#, a named project and no project each resolve as built, never from the name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-language-'));
    try {
      const project = (dir: string, file: string): string => {
        fs.mkdirSync(path.join(root, dir, 'bin', 'Debug', 'net10.0'), { recursive: true });
        fs.writeFileSync(path.join(root, dir, file), '<Project />');
        return path.join(root, dir, 'bin', 'Debug', 'net10.0', `${dir}.dll`);
      };
      const listing = (dllPath: string, projectFile?: string) => ({
        name: path.basename(dllPath, '.dll'),
        path: dllPath,
        names: [],
        ...(projectFile === undefined ? {} : { projectFile }),
      });
      const csharp = project('PropertyTests', 'PropertyTests.csproj');
      const fsharp = project('calculator', 'calculator.fsproj');
      assert.equal(projectLanguageOf(listing(csharp)), 'csharp', 'a C# "Property" test stays C#');
      assert.equal(projectLanguageOf(listing(fsharp)), 'fsharp', 'an Expecto list path is F#');
      assert.equal(
        projectLanguageOf(listing(csharp, path.join(root, 'Real.fsproj'))),
        'fsharp',
        'the project a listing names wins over the folder walk',
      );
      assert.equal(
        projectLanguageOf(listing(path.join(root, 'nowhere', 'Lost.dll'))),
        undefined,
        'no project found is no language, never a guess',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
