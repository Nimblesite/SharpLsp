import * as path from 'node:path';
import { dotnetHostEnvironment } from './dotnetRuntime.js';

/** [DIST-RUNTIME-ACQUIRE]: verify binaries before starting the language client. */
export async function verifyDeployment(extensionPath: string, dotnetPath: string) {
  const { activateShipwright } = await import('@nimblesite/shipwright-vscode');
  return await activateShipwright(
    { extensionPath },
    {
      manifestPath: path.join(extensionPath, 'shipwright.json'),
      env: { ...process.env, ...dotnetHostEnvironment(dotnetPath) },
    },
  );
}
