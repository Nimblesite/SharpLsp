// Shared steps for [WEB-DESIGN-DOCS-NAV]: on a phone the docs sidebar is a drawer
// the reader opens first; on a desktop it is already on screen.
import { expect } from '@playwright/test';

export const docsSidebar = (page) => page.locator('#docs-sidebar');

export async function openDocsMenu(page) {
  const toggle = page.locator('#docs-menu-toggle');
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
}
