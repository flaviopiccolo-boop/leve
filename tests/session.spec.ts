import { expect, test, type Page } from '@playwright/test';

test.afterEach(async ({ context }) => {
  for (const page of context.pages()) await page.close({ runBeforeUnload: false });
});

async function nativeBridge(page: Page) {
  await page.addInitScript(() => {
    let callback = 0;
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (command === 'session_load') return JSON.parse(localStorage.getItem('test-native-session') || 'null');
        if (command === 'session_save') { localStorage.setItem('test-native-session', JSON.stringify(args.session)); return; }
        if (command === 'list_shells') return [];
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:dialog|open') return 'C:\\project';
        if (command === 'set_workspace') {
          if (localStorage.getItem('test-project-missing')) throw new Error('Folder not found');
          return args.path;
        }
        if (command === 'list_directory') return [{ name: 'main.py', path: 'main.py', directory: false }];
        if (command === 'read_file') return localStorage.getItem('test-disk-content') || 'original disk content';
        if (command === 'write_file') {
          const disk = localStorage.getItem('test-disk-content') || 'original disk content';
          if (args.expected !== disk) throw new Error('The file has changed on disk.');
          localStorage.setItem('test-disk-content', args.content);
        }
      },
    } });
  });
}

test('recovers a checkpoint after an interrupted session without saving project files', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n# recovered draft');
  await page.getByRole('button', { name: 'New terminal', exact: true }).filter({ has: page.locator('svg.lucide-plus') }).click();
  await page.getByRole('menuitem', { name: 'CMD', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('leve.session.v1') || '{}').files?.[0]?.content || '')).toContain('# recovered draft');
  // A second page reads the last checkpoint without unloading or saving the first page.
  const recovered = await page.context().newPage();
  await recovered.goto('/');
  await expect(recovered.locator('.cm-content')).toContainText('# recovered draft');
  await expect(recovered.getByRole('tab', { name: 'main.py', exact: true }).locator('.dirty-dot')).toHaveCount(1);
  await expect(recovered.getByRole('tab', { name: 'CMD', exact: true })).toHaveCount(0);
  await expect(recovered.getByRole('status')).toContainText('Recovered unsaved changes');
});

test('reopens the last project and reloads clean files from disk', async ({ page }) => {
  await nativeBridge(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'No folder open', exact: true }).click();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('original disk content');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test-native-session') || '{}').root)).toBe('C:\\project');
  await page.evaluate(() => localStorage.setItem('test-disk-content', 'updated outside the editor'));
  await page.reload();
  await expect(page.getByRole('button', { name: 'project', exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('updated outside the editor');
  await expect(page.getByRole('tab', { name: 'main.py', exact: true }).locator('.dirty-dot')).toHaveCount(0);
});

test('preserves dirty buffers and the conflict baseline when disk content changes', async ({ page }) => {
  await nativeBridge(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'No folder open', exact: true }).click();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nmy unsaved draft');
  await page.evaluate(() => localStorage.setItem('test-disk-content', 'external edit'));
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('my unsaved draft');
  await expect(page.getByRole('alert')).toContainText('changed on disk');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('Could not save file');
  expect(await page.evaluate(() => localStorage.getItem('test-disk-content'))).toBe('external edit');
});

test('keeps recovery buffers when a project folder cannot be reopened', async ({ page }) => {
  await nativeBridge(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'No folder open', exact: true }).click();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nmissing project draft');
  await page.evaluate(() => localStorage.setItem('test-project-missing', 'true'));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Could not reopen');
  await expect(page.locator('.cm-content')).toContainText('missing project draft');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('Reopen the original project');
  await page.evaluate(() => localStorage.removeItem('test-project-missing'));
  await page.getByRole('button', { name: 'Retry recovery' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('missing project draft');
});

test('preserves an unreadable snapshot until the user explicitly starts a new session', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('leve.session.v1', '{broken recovery data'));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Could not load recovery');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Light', exact: true }).check();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('leve.session.v1'))).toBe('{broken recovery data');
  await expect(page.getByRole('button', { name: 'Start a new session' })).toBeVisible();
});
