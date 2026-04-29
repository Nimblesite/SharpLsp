import { test, expect } from '@playwright/test';

test.describe('Blog search', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('nav does not expose a sitewide search button', async ({ page }) => {
    await page.goto('/blog/');

    await expect(page.locator('.nav .search-link')).toHaveCount(0);
  });

  test('filters articles by search text and restores them when cleared', async ({ page }) => {
    await page.goto('/blog/');

    const search = page.getByLabel('Search articles');
    const visibleCards = page.locator('.post-card:visible');
    const initialCount = await visibleCards.count();

    expect(initialCount).toBeGreaterThan(1);

    await search.fill('diagnostic accuracy');

    await expect(visibleCards).toHaveCount(1);
    await expect(visibleCards.first().locator('.post-title')).toContainText('Diagnostic Accuracy: Errors You Can Trust');
    await expect(page.getByText('Why .NET Needs an Editor-Agnostic LSP')).not.toBeVisible();

    await search.fill('');

    await expect(visibleCards).toHaveCount(initialCount);
  });
});
