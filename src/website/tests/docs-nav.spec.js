// Tests for [WEB-DESIGN-DOCS-NAV]: the docs sidebar groups pages by what a reader is
// doing, folds the contributor pages away last, and works as a drawer on a phone.
import { readdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { docsSidebar as sidebar, openDocsMenu as openDrawer } from './docs-menu.js';

const GROUPS = {
  'Set up': ['Getting Started', 'Editor Setup', 'Zed', 'Configuration'],
  'Write code': ['F# Language Support', 'Blazor & Razor', 'Code Completions', 'Hover & Quick Info', 'Go to Definition', 'Diagnostics', 'Refactoring & Code Actions'],
  'Project tools': ['Context Menus', 'NuGet Package Manager', 'Profiler', 'Profiling F#', 'Fix a Memory Leak'],
};
const CONTRIBUTOR_PAGES = ['Architecture', 'Contributing'];
const LOCALIZED_GROUPS = { '/zh/docs/': ['安装与设置', '编写代码', '项目工具', '面向贡献者'], '/ja/docs/': ['セットアップ', 'コードを書く', 'プロジェクトツール', 'コントリビューター向け'] };

const contributors = (page) => sidebar(page).locator('details');

test('every docs page sits in exactly one group, user guides first and contributor pages last', async ({ page }) => {
  await page.goto('/docs/');
  await openDrawer(page);
  await expect(sidebar(page).locator('h2')).toHaveText(Object.keys(GROUPS));
  for (const [group, pages] of Object.entries(GROUPS)) {
    const list = sidebar(page).locator('h2', { hasText: group }).locator('xpath=following-sibling::ul[1]');
    await expect(list.locator('a'), `${group} lists its pages in order`).toHaveText(pages);
  }
  await expect(contributors(page).locator('summary')).toHaveText('For contributors');
  await expect(contributors(page).locator('a')).toHaveText(CONTRIBUTOR_PAGES);

  const linked = await sidebar(page).locator('a').evaluateAll((links) => links.map((link) => new URL(link.href).pathname));
  const published = readdirSync(new URL('../src/docs/', import.meta.url)).map((file) => (file === 'index.md' ? '/docs/' : `/docs/${file.replace(/\.md$/, '')}/`));
  expect(new Set(linked).size, 'no page is listed twice').toBe(linked.length);
  expect([...linked].sort(), 'every published docs page is in the sidebar').toEqual(published.sort());
});

test('the contributor group stays folded for readers and opens on its own pages', async ({ page }) => {
  await page.goto('/docs/profiler/');
  await openDrawer(page);
  await expect(sidebar(page).locator('a[aria-current="page"]')).toHaveText('Profiler');
  await expect(contributors(page)).not.toHaveAttribute('open', '');
  await expect(contributors(page).getByRole('link', { name: 'Architecture' })).toBeHidden();

  await contributors(page).locator('summary').click();
  await expect(contributors(page)).toHaveAttribute('open', '');
  await contributors(page).getByRole('link', { name: 'Architecture' }).click();
  await expect(page).toHaveURL(/\/docs\/architecture\/$/);

  await openDrawer(page);
  await expect(contributors(page), 'the reader lands with the group they chose still open').toHaveAttribute('open', '');
  await expect(sidebar(page).locator('a.active[aria-current="page"]')).toHaveText('Architecture');
  await expect(sidebar(page).locator('a[aria-current]')).toHaveCount(1);
});

for (const [path, labels] of Object.entries(LOCALIZED_GROUPS)) {
  test(`${path} groups its sidebar in the page's language and links within it`, async ({ page }) => {
    await page.goto(path);
    await openDrawer(page);
    await expect(sidebar(page).locator('h2, summary')).toHaveText(labels);
    const prefix = path.slice(0, -'docs/'.length);
    const hrefs = await sidebar(page).locator('a').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect(hrefs.every((href) => href.startsWith(`${prefix}docs/`)), 'no link drops the reader back into English').toBe(true);
    await expect(sidebar(page).locator('a[aria-current="page"]')).toHaveAttribute('href', path);
  });
}

test.describe('phone drawer', () => {
  test.beforeEach(({ isMobile }) => test.skip(!isMobile, 'the phone layout'));

  test('the menu control follows the reader down the page and the drawer fills the screen below it', async ({ page }) => {
    await page.goto('/docs/hover/');
    await page.evaluate(() => window.scrollTo(0, 1500));
    const toggle = page.locator('#docs-menu-toggle');
    await expect(toggle, 'the menu is one tap away mid-article').toBeInViewport();
    await openDrawer(page);

    const viewport = page.viewportSize();
    await expect.poll(async () => (await sidebar(page).boundingBox()).x).toBe(0);
    const [control, drawer] = await Promise.all([toggle.boundingBox(), sidebar(page).boundingBox()]);
    expect(drawer.y, 'the drawer opens directly under the menu control').toBeCloseTo(control.y + control.height, 0);
    expect(drawer.y + drawer.height, 'the drawer reaches the bottom of the screen').toBeCloseTo(viewport.height, 0);
    await expect(sidebar(page).locator('h2').first(), 'the first group is visible, not hidden under the header').toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no sideways scroll').toBe(viewport.width);
  });

  test('every entry is a full touch target, and a tap beside the drawer closes it', async ({ page }) => {
    await page.goto('/docs/');
    await openDrawer(page);
    const heights = await sidebar(page).locator('a, summary').evaluateAll((targets) => targets.map((target) => target.getBoundingClientRect().height));
    expect(Math.min(...heights.filter(Boolean)), 'targets are at least 44px tall').toBeGreaterThanOrEqual(44);

    await contributors(page).locator('summary').click();
    await contributors(page).getByRole('link', { name: 'Contributing' }).scrollIntoViewIfNeeded();
    await expect(contributors(page).getByRole('link', { name: 'Contributing' })).toBeInViewport();

    const viewport = page.viewportSize();
    await page.mouse.click(viewport.width - 8, viewport.height / 2);
    await expect(page.locator('#docs-menu-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar(page)).not.toHaveClass(/\bopen\b/);
  });
});
