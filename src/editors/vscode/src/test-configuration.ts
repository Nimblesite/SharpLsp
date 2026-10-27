// Implements [TEST-BUILD-CONFIGURATION], [CONFIG-EDITOR-BRIDGE].
import { fileUri } from './paths';
import * as state from './state';

/** Resolve the test build configuration for this scope on every operation. */
export async function testConfiguration(scope: string): Promise<string> {
  const client = state.client.value;
  if (client === undefined) return 'Debug';
  const resolved = await client.sendRequest<{ testing: { configuration: string } }>(
    'sharplsp/configuration',
    { scopeUri: fileUri(scope).toString() },
  );
  return resolved.testing.configuration;
}

/** One explicit global property, shared by test builds and output evaluation. */
export async function testConfigurationArgs(scope: string): Promise<string[]> {
  return [`-p:Configuration=${await testConfiguration(scope)}`];
}
