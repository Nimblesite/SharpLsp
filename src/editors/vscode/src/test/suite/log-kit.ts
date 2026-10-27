// Reading the extension's own log back, for suites that assert what it told
// the user. The log is written asynchronously, so a line is polled for rather
// than read once.
import * as fs from 'node:fs';
import { logFilePath } from '../../log.js';
import { pollUntilResult } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

/** The first line of the extension log that `matches`, once the log holds one. */
export async function loggedLine(
  matches: (line: string) => boolean,
  waitingFor: string,
): Promise<string> {
  const line = await pollUntilResult(
    async () => (await fs.promises.readFile(logFilePath(), 'utf8')).split('\n').find(matches),
    (found) => found !== undefined,
    LSP_RESPONSE_MS,
    undefined,
    waitingFor,
  );
  return line ?? '';
}
