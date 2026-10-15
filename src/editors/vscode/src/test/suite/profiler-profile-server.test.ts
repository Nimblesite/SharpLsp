// Tests for [PROF-UI-WEBVIEW]. See
// docs/specs/LSP-PROFILER-SPEC.md
//
// "Open in Speedscope" must actually load the profile: speedscope.app is https
// and can never read file:// URLs, so the extension serves the exported JSON
// over a loopback HTTP URL its importer can fetch. These tests pin the served
// response (body, CORS, no-store) and the containment properties (unguessable
// token required, expiry, teardown) — without them the button regresses to
// dumping the user on speedscope's empty "Browse" landing page.

import { delay } from '@nimblesite/lsp-profiler-ui/out/src/timeouts';
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  disposeProfileServer,
  serveProfileForBrowser,
} from '@nimblesite/lsp-profiler-ui/out/src/profile-server';
import { removeTestDir } from './profiler-ui-helpers';

/** GET a URL and resolve status, headers, and body. */
async function fetchUrl(
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      })
      .on('error', reject);
  });
}

suite('Profile loopback server — speedscope deep links load automatically', () => {
  let tmpDir: string;
  let profilePath: string;
  const profileJson = '{"$schema":"https://www.speedscope.app/file-format-schema.json"}';

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsk-profile-server-'));
    profilePath = path.join(tmpDir, 'profile.speedscope.json');
    fs.writeFileSync(profilePath, profileJson);
  });

  suiteTeardown(() => {
    disposeProfileServer();
    removeTestDir(tmpDir);
  });

  test("a registered profile is served with the headers speedscope's importer needs", async () => {
    const url = await serveProfileForBrowser(profilePath);
    assert.ok(
      url.startsWith('http://127.0.0.1:'),
      `the URL must be loopback-only, never file:// ([PROF-UI-WEBVIEW]); got ${url}`,
    );
    assert.ok(
      url.endsWith('/profile.speedscope.json'),
      `the URL must carry the real basename so speedscope's extension-based ` +
        `format detection works (.heapprofile vs speedscope JSON); got ${url}`,
    );
    const response = await fetchUrl(url);
    assert.strictEqual(response.status, 200, 'the registered profile must be fetchable');
    assert.strictEqual(response.body, profileJson, 'the body must be the exact exported JSON');
    assert.strictEqual(
      response.headers['access-control-allow-origin'],
      '*',
      'speedscope.app fetches cross-origin — without CORS the import fails silently',
    );
    assert.strictEqual(
      response.headers['cache-control'],
      'no-store',
      'profiles must never be cached beyond the registration',
    );
  });

  test('an unregistered or malformed token is a 404 — the token is the access control', async () => {
    const url = await serveProfileForBrowser(profilePath);
    const base = url.slice(0, url.indexOf('/', 'http://'.length));
    const wrongToken = await fetchUrl(`${base}/${'0'.repeat(32)}/profile.json`);
    assert.strictEqual(wrongToken.status, 404, 'an unknown token must not serve anything');
    const noToken = await fetchUrl(`${base}/profile.json`);
    assert.strictEqual(noToken.status, 404, 'a token-less path must not serve anything');
  });

  test('an expired registration stops being served', async () => {
    const url = await serveProfileForBrowser(profilePath, 1);
    await delay(10);
    const response = await fetchUrl(url);
    assert.strictEqual(
      response.status,
      404,
      'expired registrations must 404, not serve stale data',
    );
  });

  test('dispose tears the server down — nothing stays reachable after deactivate', async () => {
    const url = await serveProfileForBrowser(profilePath);
    disposeProfileServer();
    await assert.rejects(
      fetchUrl(url),
      'after dispose the port must refuse connections ([PROF-UI-WEBVIEW] containment)',
    );
  });
});
