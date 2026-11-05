import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('opens the demo image through file search and offers both scales', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.statusbar')).toContainText('Recovery saved');
  await page.keyboard.press('Control+p');
  await page.locator('#file-search').fill('leve.png');
  await page.locator('.search-result').filter({ hasText: 'leve.png' }).click();
  await expect(page.getByRole('img', { name: 'leve.png' })).toBeVisible();
  await expect(page.getByText(/256 × 256 px/)).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Image · Read-only');
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await page.getByRole('button', { name: '100%', exact: true }).click();
  await expect(page.getByRole('button', { name: '100%', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fit', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('reloads a desktop image from the workspace without saving its bytes in recovery', async ({ page }) => {
  const image = readFileSync(new URL('../docs/images/leve-windows.png', import.meta.url)).toString('base64');
  await page.addInitScript(image => {
    let callback = 0;
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command: string, args: { path?: string; expectedRoot?: string; session?: unknown } = {}) => {
        if (command === 'session_load') return JSON.parse(localStorage.getItem('test-image-session') || 'null');
        if (command === 'session_save') return localStorage.setItem('test-image-session', JSON.stringify(args.session));
        if (command === 'list_shells') return [];
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:dialog|open') return 'C:\\project';
        if (command === 'set_workspace') return args.path;
        if (command === 'list_directory') return ['Logo.PNG', 'broken.png'].map(path => ({ name: path, path, directory: false }));
        if (command === 'read_image') {
          if (args.expectedRoot !== 'C:\\project') throw new Error('Expected the current workspace root.');
          if (args.path === 'broken.png') return new Uint8Array([1, 2, 3]).buffer;
          if (args.path === 'Logo.PNG') return Uint8Array.from(atob(image), byte => byte.charCodeAt(0)).buffer;
        }
      },
    } });
  }, image);
  await page.goto('/');
  await page.locator('.project-picker').click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  await page.getByRole('button', { name: 'Logo.PNG', exact: true }).click();
  await expect(page.getByText(/1400 × 900 px/)).toBeVisible();
  const preview = page.getByRole('region', { name: 'Image preview' });
  await expect.poll(() => preview.evaluate(stage => stage.scrollWidth - stage.clientWidth)).toBe(0);
  await page.getByRole('button', { name: '100%', exact: true }).click();
  await expect.poll(() => preview.evaluate(stage => stage.scrollWidth - stage.clientWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test-image-session') || '{}').files)).toEqual([
    { path: 'Logo.PNG', name: 'Logo.PNG', image: true, content: '', saved: '' },
  ]);
  await page.reload();
  await expect(page.getByRole('img', { name: 'Logo.PNG' })).toBeVisible();
  await expect(page.getByText(/1400 × 900 px/)).toBeVisible();
  await page.getByRole('button', { name: 'broken.png', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not preview broken.png');
});
