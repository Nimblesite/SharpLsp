import path from 'node:path';

// Simulates: activate.js candidatePaths + resolve.js bundled-source lookup
// for the installed extension on Windows. If these strings don't match, the
// Map.get(candidate) inside resolve() returns undefined — and probe is reported
// as "not found" even though it actually succeeded.

const bundledDir = path.dirname(
  'C:\\Users\\chris\\.vscode\\extensions\\nimblesite.sharplsp-0.1.0\\bin\\all\\sharplsp-sidecar-csharp.exe',
);

const fromPathJoin = path.join(bundledDir, 'sharplsp-sidecar-csharp.exe');

const endsWithSep = bundledDir.endsWith('/') || bundledDir.endsWith('\\');
const slash = endsWithSep ? '' : '/';
const fromJoinBinary = `${bundledDir}${slash}sharplsp-sidecar-csharp.exe`;

console.log('Map key (activate.js path.join): ', JSON.stringify(fromPathJoin));
console.log('Lookup   (resolve.js joinBinary):', JSON.stringify(fromJoinBinary));
console.log('Match:', fromPathJoin === fromJoinBinary);
