// Tests for [NUGET-BROWSER-SPEC]: the panel's initial load reports what it did.
//
// Regression for #293. With no target project selected the initial load lists
// and searches nothing, so `waitForInitialLoad()` used to resolve exactly as a
// finished load does, on an empty Browse tab. It must report `unresolved`, and
// the panel must show why rather than a silent empty list.
import * as assert from 'node:assert/strict';
import { NuGetBrowserPanel } from '../../nuget-browser.js';
import {
  fakeContextWithStore,
  openFreshPanel,
  resetPanelSingleton,
  VIRTUAL_PROJECT,
} from './nuget-browser-kit';
import { LSP_RESPONSE_MS } from './test-timeouts';

const NO_CLIENT_TOAST = 'LSP client not available';

function assertUnresolvedPanel(panel: NuGetBrowserPanel, when: string): void {
  assert.strictEqual(panel.getSelectedTargetId(), undefined, `${when}: no target is selected`);
  assert.deepStrictEqual(panel.getTargetIds(), [], `${when}: no targets were loaded`);
  assert.strictEqual(panel.getSearchResultsCount(), 0, `${when}: nothing was searched`);
  assert.deepStrictEqual(panel.getActiveLoadingKeys(), [], `${when}: no spinner is left running`);
  assert.ok(
    panel.getRenderedHtml().includes(NO_CLIENT_TOAST),
    `${when}: the panel says why it is empty`,
  );
}

suite('NuGet browser — initial load outcome', () => {
  teardown(resetPanelSingleton);

  test('a panel with no language client reports an unresolved load, not a finished one', async function () {
    this.timeout(LSP_RESPONSE_MS);

    // Interaction 1 — open with no client: the load is unresolved and says why.
    const panel = openFreshPanel(VIRTUAL_PROJECT, 'NoClient', () => undefined);
    assert.strictEqual(
      await panel.waitForInitialLoad(),
      'unresolved',
      'a load that selected no target must not report completion',
    );
    assertUnresolvedPanel(panel, 'after the initial load');

    // Interaction 2 — reopening reuses the panel; its outcome does not change.
    const reopened = NuGetBrowserPanel.open(
      fakeContextWithStore(),
      VIRTUAL_PROJECT,
      'NoClient',
      () => undefined,
    );
    assert.strictEqual(reopened, panel, 'open() reveals the existing panel');
    assert.strictEqual(await reopened.waitForInitialLoad(), 'unresolved', 'the outcome is stable');
    assertUnresolvedPanel(reopened, 'after reopening');

    // Interaction 3 — a fresh panel after dispose runs its own load, unresolved again.
    const fresh = openFreshPanel(VIRTUAL_PROJECT, 'NoClientAgain', () => undefined);
    assert.notStrictEqual(fresh, panel, 'a disposed panel is replaced by a new one');
    assert.strictEqual(
      await fresh.waitForInitialLoad(),
      'unresolved',
      'the fresh load is unresolved',
    );
    assertUnresolvedPanel(fresh, 'in the fresh panel');
  });
});
