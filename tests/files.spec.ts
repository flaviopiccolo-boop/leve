import { expect, test, type Page } from '@playwright/test';

const row = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

test.afterEach(async ({ context }) => {
  for (const page of context.pages()) await page.close({ runBeforeUnload: false });
});

test('creates a file from the toolbar and opens it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New file' }).click();
  await page.getByLabel('New file name').fill('notes.txt');
  await page.keyboard.press('Enter');
  await expect(row(page, 'notes.txt')).toBeVisible();
  await expect(tab(page, 'notes.txt')).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('hello');
  await page.keyboard.press('Control+s');
  await expect(tab(page, 'notes.txt').locator('.dirty-dot')).toHaveCount(0);
});

test('creates nested entries from the context menu and finds them', async ({ page }) => {
  await page.goto('/');
  await row(page, 'src').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  await page.getByLabel('New folder name').fill('models');
  await page.keyboard.press('Enter');
  await row(page, 'models').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New file' }).click();
  await page.getByLabel('New file name').fill('user.py');
  await page.keyboard.press('Enter');
  await expect(row(page, 'user.py')).toBeVisible();
  await page.keyboard.press('Control+p');
  await page.locator('#file-search').fill('models/user');
  await expect(page.locator('.search-result')).toContainText('src/models/user.py');
});

test('rejects invalid and duplicate names and keeps the input open', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New file' }).click();
  const input = page.getByLabel('New file name');
  await input.fill('bad:name');
  await expect(page.getByRole('alert')).toContainText('cannot contain');
  await page.keyboard.press('Enter');
  await expect(input).toBeVisible();
  await input.fill('README.md');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('already exists');
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'README.md' })).toHaveCount(0);
});

test('renames an open file with F2 and keeps its unsaved changes', async ({ page }) => {
  await page.goto('/');
  await row(page, 'main.py').click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('# keep me');
  await row(page, 'main.py').focus();
  await page.keyboard.press('F2');
  const input = page.getByLabel('Rename main.py');
  await expect(input).toBeFocused();
  // The extension stays out of the selection, so typing replaces only the name.
  await page.keyboard.type('app');
  await expect(input).toHaveValue('app.py');
  await page.keyboard.press('Enter');
  await expect(row(page, 'app.py')).toBeVisible();
  await expect(tab(page, 'main.py')).toHaveCount(0);
  await expect(tab(page, 'app.py').locator('.dirty-dot')).toHaveCount(1);
  await expect(page.locator('.cm-content')).toContainText('# keep me');
  await page.keyboard.press('Control+s');
  await expect(tab(page, 'app.py').locator('.dirty-dot')).toHaveCount(0);
});

test('renaming a folder updates its open files and stays expanded', async ({ page }) => {
  await page.goto('/');
  await row(page, 'main.py').click();
  await row(page, 'src').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Rename src').fill('app');
  await page.keyboard.press('Enter');
  await expect(row(page, 'app')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'main.py')).toHaveAttribute('title', 'app/main.py');
  await expect(tab(page, 'main.py')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('from services.greeting import greet');
});

test('renames the only tab of a split group without losing the group', async ({ page }) => {
  await page.goto('/');
  await row(page, 'main.py').click();
  const source = await tab(page, 'main.py').boundingBox();
  const editor = await page.locator('.cm-editor').boundingBox();
  await page.mouse.move(source!.x + 10, source!.y + 10);
  await page.mouse.down();
  await page.mouse.move(editor!.x + editor!.width - 15, editor!.y + editor!.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.flexlayout__tabset')).toHaveCount(4);
  await row(page, 'main.py').focus();
  await page.keyboard.press('F2');
  await page.getByLabel('Rename main.py').fill('split.py');
  await page.keyboard.press('Enter');
  await expect(tab(page, 'split.py')).toBeVisible();
  await expect(page.locator('.flexlayout__tabset')).toHaveCount(4);
  await expect(page.locator('.cm-content')).toContainText('from services.greeting import greet');
});

test('deletes a file with the Delete key after confirmation', async ({ page }) => {
  await page.goto('/');
  await row(page, 'requirements.txt').click();
  await row(page, 'requirements.txt').focus();
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Delete');
  await expect(row(page, 'requirements.txt')).toBeVisible();
  let message = '';
  page.once('dialog', dialog => { message = dialog.message(); void dialog.accept(); });
  await page.keyboard.press('Delete');
  await expect(row(page, 'requirements.txt')).toHaveCount(0);
  await expect(tab(page, 'requirements.txt')).toHaveCount(0);
  expect(message).toBe('Delete requirements.txt?');
});

test('deleting a folder warns about unsaved changes and closes its tabs', async ({ page }) => {
  await page.goto('/');
  await row(page, 'main.py').click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('# draft');
  await row(page, 'src').click({ button: 'right' });
  let message = '';
  page.once('dialog', dialog => { message = dialog.message(); void dialog.accept(); });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(row(page, 'src')).toHaveCount(0);
  await expect(tab(page, 'main.py')).toHaveCount(0);
  expect(message).toContain('Unsaved changes in 1 open file(s) will be lost.');
});

test('uses the backend and the Recycle Bin in the desktop app', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).calls = [];
    let entries = [{ name: 'main.py', path: 'main.py', directory: false }];
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (['create_file', 'create_directory', 'rename_path', 'delete_path', 'plugin:dialog|message'].includes(command)) (window as any).calls.push([command, args]);
        if (command === 'session_load') return { version: 1, root: 'C:\\project', files: [], activeFile: '', layout: { global: {}, borders: [], layout: { type: 'row', children: [] } } };
        if (command === 'set_workspace') return args.path;
        if (command === 'list_shells') return [];
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:dialog|message') return 'Ok';
        if (command === 'list_directory') return args.path ? [] : entries;
        if (command === 'read_file') return '';
        if (command === 'create_file') { entries = [...entries, { name: args.path, path: args.path, directory: false }]; return; }
        if (command === 'create_directory') throw 'Access is denied.';
        if (command === 'rename_path') { entries = [{ name: args.newName, path: args.newName, directory: false }]; return args.newName; }
        if (command === 'delete_path') { entries = []; return; }
      },
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('New folder name').fill('denied');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Access is denied.');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New file' }).click();
  await page.getByLabel('New file name').fill('new.py');
  await page.keyboard.press('Enter');
  await expect(tab(page, 'new.py')).toBeVisible();
  await row(page, 'main.py').focus();
  await page.keyboard.press('F2');
  await page.getByLabel('Rename main.py').fill('app.py');
  await page.keyboard.press('Enter');
  await expect(row(page, 'app.py')).toBeVisible();
  await row(page, 'app.py').focus();
  await page.keyboard.press('Delete');
  await expect(row(page, 'app.py')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('moved to the Recycle Bin');
  const calls = await page.evaluate(() => (window as any).calls);
  expect(calls.map((call: any[]) => call[0])).toEqual(['create_directory', 'create_file', 'rename_path', 'plugin:dialog|message', 'delete_path']);
  expect(calls[2][1]).toEqual({ path: 'main.py', newName: 'app.py' });
  expect(calls[3][1].message).toContain('Move app.py to the Recycle Bin?');
});
