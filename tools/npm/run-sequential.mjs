import { spawnSync } from 'node:child_process';

const scripts = process.argv.slice(2);
const npmCli = process.env.npm_execpath;

if (scripts.length === 0) {
  console.error('Usage: run-sequential.mjs <npm-script> [...]');
  process.exit(2);
}

if (!npmCli) {
  console.error('run-sequential.mjs must be launched from an npm script.');
  process.exit(2);
}

for (const script of scripts) {
  const result = spawnSync(process.execPath, [npmCli, 'run', script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`Unable to run npm script "${script}": ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
