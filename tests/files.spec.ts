import { expect, test, type Page } from '@playwright/test';

async function action(page: Page, path: string, name: string) {
  await page.getByRole('button', { name: `Actions for ${path}`, exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

async function create(page: Page, kind: 'file' | 'folder', name: string) {
  await page.getByRole('button', { name: `New ${kind}`, exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.afterEach(async ({ page }) => { await page.close({ runBeforeUnload: false }); });

test('creates files and folders, including a file inside an empty folder', async ({ page }) => {
  await page.goto('/');
  await create(page, 'folder', 'my-folder');
  await action(page, 'my-folder', 'New file…');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('new.py');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'new.py', exact: true })).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('print("created")');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('tab', { name: 'new.py', exact: true }).locator('.dirty-dot')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Actions for my-folder/new.py', exact: true })).toBeAttached();
});

test('renames a folder with a dirty open file, preserves edits and saves to the renamed path', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n# keep renamed draft');
  await action(page, 'src', 'Rename…');
  await expect(page.getByRole('dialog')).toContainText('Unsaved edits will be kept');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('renamed');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('# keep renamed draft');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('tab', { name: 'main.py', exact: true }).locator('.dirty-dot')).toHaveCount(0);
  await page.getByRole('tab', { name: 'main.py', exact: true }).locator('.flexlayout__tab_button_trailing').click();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('# keep renamed draft');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('leve.session.v1') || '{}').files?.[0]?.path)).toBe('renamed/main.py');
});

test('delete requires confirmation and warns about unsaved files in the folder', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('# dirty ');
  await action(page, 'src', 'Delete…');
  await expect(page.getByRole('dialog')).toContainText('1 open file(s) have unsaved changes');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('# dirty');
  await action(page, 'src', 'Delete…');
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'main.py', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Actions for src', exact: true })).toHaveCount(0);
});

test('rejects invalid names and duplicate entries without losing existing files', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('../escape');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('valid Windows');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('README.md');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already exists');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Your next project starts here');
});

test('a renamed file and a new file at its old path keep separate tabs and recovery buffers', async ({ page }) => {
  await page.goto('/');
  await create(page, 'file', 'first.py');
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('# original draft');
  await action(page, 'first.py', 'Rename…');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('second.py');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await create(page, 'file', 'first.py');
  await expect(page.getByRole('tab', { name: 'first.py', exact: true })).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'second.py', exact: true })).toHaveCount(1);
  await expect(page.locator('.cm-content').filter({ visible: true })).toHaveText('');
  await page.getByRole('tab', { name: 'second.py', exact: true }).click();
  await expect(page.locator('.cm-content').filter({ visible: true })).toContainText('# original draft');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('leve.session.v1') || '{}').files?.length)).toBe(2);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'first.py', exact: true })).toHaveCount(0);
  // The missing clean demo file is skipped; the renamed unsaved draft is recovered once.
  await expect(page.getByRole('tab', { name: 'second.py', exact: true })).toHaveCount(1);
  await expect(page.locator('.cm-content')).toContainText('# original draft');
});

test('desktop file operations send the selected project and synchronize open tabs', async ({ page }) => {
  await page.addInitScript(() => {
    const disk: Record<string, string> = {};
    const calls: { command: string; args: any }[] = [];
    let callback = 0;
    Object.assign(window, { fileCalls: calls, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        calls.push({ command, args });
        if (command === 'session_load') return null;
        if (command === 'list_shells') return [];
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:dialog|open') return 'C:\\native-project';
        if (command === 'set_workspace') return args.path;
        if (command === 'list_directory') return Object.keys(disk).map(path => ({ name: path, path, directory: false }));
        if (command === 'read_file') return disk[args.path];
        if (command === 'create_entry') { disk[args.name] = ''; return args.name; }
        if (command === 'rename_entry') { disk[args.name] = disk[args.path]; delete disk[args.path]; return args.name; }
        if (command === 'delete_entry') delete disk[args.path];
      },
    } });
  });
  await page.goto('/');
  await page.locator('.project-picker').click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  await create(page, 'file', 'one.py');
  await action(page, 'one.py', 'Rename…');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('two.py');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'two.py', exact: true })).toBeVisible();
  await action(page, 'two.py', 'Delete…');
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'two.py', exact: true })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).fileCalls.filter((call: any) => ['create_entry', 'rename_entry', 'delete_entry'].includes(call.command)));
  expect(calls).toEqual([
    { command: 'create_entry', args: { parent: '', name: 'one.py', directory: false, expectedRoot: 'C:\\native-project' } },
    { command: 'rename_entry', args: { path: 'one.py', name: 'two.py', expectedRoot: 'C:\\native-project' } },
    { command: 'delete_entry', args: { path: 'two.py', expectedRoot: 'C:\\native-project' } },
  ]);
});
