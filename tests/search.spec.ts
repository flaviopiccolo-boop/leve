import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => { await page.close({ runBeforeUnload: false }); });

test('finds literal text across files and opens the match at the correct position', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+Shift+f');
  await page.getByRole('textbox', { name: 'Search project contents' }).fill('greet("world")');
  const match = page.locator('.content-result');
  await expect(match).toHaveCount(1);
  await expect(match).toContainText('src/main.py:5:15');
  await match.click();
  await expect(page.locator('.cm-content')).toContainText('message = greet');
  await expect(page.locator('.statusbar')).toContainText('Ln 5, Col 29');
  await page.keyboard.press('Control+p');
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#file-search')).toBeFocused();
});

test('supports case-sensitive content searches and handles zero results', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+Shift+f');
  await page.getByRole('textbox', { name: 'Search project contents' }).fill('GREET');
  await expect(page.locator('.content-result')).toHaveCount(4);
  await page.getByRole('checkbox', { name: 'Match case' }).check();
  await expect(page.locator('.content-result')).toHaveCount(0);
  await expect(page.locator('.content-search [role="status"]')).toContainText('0 match(es)');
  await page.getByRole('textbox', { name: 'Search project contents' }).fill('[not regex');
  await expect(page.locator('.content-search [role="status"]')).toContainText('0 match(es)');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('does not replace unsaved edits when a saved search result is stale', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('# shifted line\n');
  await page.keyboard.press('Control+Shift+f');
  await page.getByRole('textbox', { name: 'Search project contents' }).fill('greet("world")');
  await page.locator('.content-result').click();
  await expect(page.locator('.cm-content')).toContainText('# shifted line');
  await expect(page.locator('.toast')).toContainText('no longer matches');
  await expect(page.getByRole('tab', { name: 'main.py', exact: true }).locator('.dirty-dot')).toHaveCount(1);
});

test('cancels native searches and ignores delayed results from an older query', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { command: string; args: any }[] = [];
    let callback = 0;
    Object.assign(window, { searchCalls: calls, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        calls.push({ command, args });
        if (command === 'session_load') return null;
        if (command === 'list_shells' || command === 'list_directory') return [];
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:dialog|open') return 'C:\\project';
        if (command === 'set_workspace') return args.path;
        if (command === 'search_content') {
          await new Promise(resolve => setTimeout(resolve, args.query === 'old' ? 700 : 10));
          if (args.query === 'old') Object.assign(window, { oldSearchFinished: true });
          return { matches: [{ path: `${args.query}.py`, line: 1, column: 1, length: 3, matchedText: args.query, preview: args.query }], scanned: 1, skipped: 0, limit: null };
        }
      },
    } });
  });
  await page.goto('/');
  await page.locator('.project-picker').click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  await page.keyboard.press('Control+Shift+f');
  await page.getByRole('textbox', { name: 'Search project contents' }).fill('old');
  await expect.poll(() => page.evaluate(() => (window as any).searchCalls.filter((call: any) => call.command === 'search_content').length)).toBe(1);
  await page.getByRole('textbox', { name: 'Search project contents' }).fill('new');
  await expect(page.locator('.content-result')).toContainText('new.py');
  await expect.poll(() => page.evaluate(() => (window as any).searchCalls.filter((call: any) => call.command === 'cancel_search').length)).toBeGreaterThan(0);
  await page.getByRole('textbox', { name: 'Search project contents' }).fill('newer');
  await expect(page.locator('.content-result')).toContainText('newer.py');
  await expect.poll(() => page.evaluate(() => !!(window as any).oldSearchFinished)).toBe(true);
  await expect(page.locator('.content-result')).toContainText('newer.py');
  await expect(page.locator('.content-result')).toHaveCount(1);
});
