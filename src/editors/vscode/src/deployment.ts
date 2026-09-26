import { joinPath } from './paths';
import type { ActivationResult } from '@nimblesite/shipwright-vscode' with {
  'resolution-mode': 'import',
};
import { dotnetHostEnvironment } from './dotnetRuntime.js';

/** [DIST-RUNTIME-ACQUIRE]: verify binaries before starting the language client. */
export async function verifyDeployment(
  extensionPath: string,
  dotnetPath: string,
): Promise<ActivationResult> {
  const { activateShipwright } = await import('@nimblesite/shipwright-vscode');
  return await activateShipwright(
    { extensionPath },
    {
      manifestPath: joinPath(extensionPath, 'shipwright.json'),
      env: { ...process.env, ...dotnetHostEnvironment(dotnetPath) },
    },
  );
}
