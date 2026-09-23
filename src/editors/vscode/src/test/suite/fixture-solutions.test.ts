// Implements [SE-ACTIONS-BUILD-FIXTURES]: exit zero must mean projects built.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dotnet } from './dotnet-project-kit';
import { FAST_MS, FIXTURE_BUILD_MS } from './test-timeouts';

const fixture = path.resolve(__dirname, '../../../test-fixtures/workspace');
const solutions = fs
  .readdirSync(fixture)
  .filter((file) => ['.sln', '.slnx'].includes(path.extname(file)));
const projects = [
  ['fsharp', 'FSharpFixtures'],
  ['', 'TestFixtures'],
  ['crosslanguage', 'CSharpConsumer'],
] as const;

for (const solution of solutions) {
  for (const configuration of ['Debug', 'Release']) {
    suite(`Selectable fixture solution — ${solution} / ${configuration}`, () => {
      let root: string;
      let output: string;

      suiteSetup(async function () {
        this.timeout(FIXTURE_BUILD_MS);
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-solution-build-'));
        fs.cpSync(fixture, root, {
          recursive: true,
          filter: (source) =>
            !['bin', 'obj'].includes(path.basename(source)) &&
            !path.basename(source).startsWith('debug-'),
        });
        output = await dotnet(['build', solution, '-c', configuration, '--nologo'], root);
      });

      suiteTeardown(() => {
        if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
      });

      test('builds every declared F# and C# project from source, not just an empty solution', function () {
        this.timeout(FAST_MS);
        for (const [directory, assembly] of projects) {
          const binary = path.join(
            root,
            directory,
            'bin',
            configuration,
            'net10.0',
            `${assembly}.dll`,
          );
          assert.ok(fs.existsSync(binary), `${solution} did not build ${assembly}:\n${output}`);
          assert.ok(fs.statSync(binary).size > 0, `${assembly} must contain compiled code`);
        }
        assert.ok(!output.includes('Unable to find a project to restore'), output);
      });
    });
  }
}
