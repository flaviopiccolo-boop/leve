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
        if (command === 'plugin:dialog|message') return localStorage.getItem('test-confirm') === 'cancel' ? 'Cancel' : 'Ok';
        if (command === 'plugin:dialog|open') {
          if (args.options?.title === 'Choose a folder inside the project') return localStorage.getItem('test-save-folder');
          localStorage.setItem('test-picker-count', String(Number(localStorage.getItem('test-picker-count')) + 1));
          return localStorage.getItem('test-next-project') || 'C:\\project';
        }
        if (command === 'set_workspace') {
          if (localStorage.getItem('test-project-missing')) throw new Error('Folder not found');
          return args.path;
        }
        if (command === 'list_directory') return [
          { name: 'main.py', path: 'main.py', directory: false },
          ...(localStorage.getItem('test-other-file') !== null ? [{ name: 'other.py', path: 'other.py', directory: false }] : []),
        ];
        const diskKey = args.path === 'other.py' ? 'test-other-file' : 'test-disk-content';
        if (command === 'read_file' && args.path.endsWith('.editorconfig')) {
          const config = localStorage.getItem(`test-config:${args.path}`);
          if (config === null) throw new Error('File not found');
          return config;
        }
        if (command === 'read_file') return localStorage.getItem(diskKey) ?? 'original disk content';
        if (command === 'write_file') {
          const disk = localStorage.getItem(diskKey) ?? 'original disk content';
          if (args.expected !== disk) throw new Error('The file has changed on disk.');
          localStorage.setItem(diskKey, args.content);
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
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…', exact: true }).click();
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
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
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

test('browses for a Save As folder and keeps the destination inside the project', async ({ page }) => {
  await nativeBridge(page);
  await page.goto('/');
  const file = page.getByRole('button', { name: 'File', exact: true });
  await file.click();
  await page.getByRole('menuitem', { name: 'Open folder…', exact: true }).click();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await file.click();
  await page.getByRole('menuitem', { name: 'Save As…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save As', exact: true });
  const browse = dialog.getByRole('button', { name: 'Browse…' });
  const path = dialog.getByLabel('Destination path');
  await page.evaluate(() => localStorage.setItem('test-save-folder', 'C:\\project-other'));
  await browse.click();
  await expect(dialog.getByRole('alert')).toContainText('inside the current project');
  await expect(path).toHaveValue('main.py');
  await page.evaluate(() => localStorage.setItem('test-save-folder', 'C:\\PROJECT\\docs'));
  await browse.click();
  await expect(path).toHaveValue('docs/main.py');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('applies EditorConfig indentation and allows overriding one tab', async ({ page }) => {
  await nativeBridge(page);
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('test-config:.editorconfig', 'root = true\n[*.{py,js}]\nindent_style = space\nindent_size = 3\n[other.py]\nindent_style = tab\nindent_size = tab\ntab_width = 4');
    localStorage.setItem('test-other-file', 'other');
  });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…', exact: true }).click();
  const indentation = page.getByRole('combobox', { name: 'File indentation' });
  const code = page.locator('.cm-content:visible');
  const indentLine = async () => {
    await code.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    return code.locator('.cm-line').first().textContent();
  };
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await expect(indentation.locator('option:checked')).toHaveText('Auto · Spaces: 3');
  expect(await indentLine()).toBe('   original disk content');
  await indentation.selectOption('spaces:8');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'other.py', exact: true }).click();
  await expect(indentation.locator('option:checked')).toHaveText('Auto · Tabs: 4');
  expect(await indentLine()).toBe('\tother');
  await page.getByRole('tab', { name: 'main.py', exact: true }).click();
  await expect(indentation).toHaveValue('spaces:8');
  await indentation.selectOption('auto');
  await expect(indentation.locator('option:checked')).toHaveText('Auto · Spaces: 3');
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Editor', exact: true }).click();
  const useEditorConfig = settings.getByRole('checkbox', { name: 'Use project indentation rules (.editorconfig)' });
  await expect(useEditorConfig).toBeChecked();
  await useEditorConfig.uncheck();
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await expect(indentation.locator('option:checked')).toHaveText('Auto · Spaces: 2');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('leve.editor.v1')!).useEditorConfig)).toBe(false);
});

test('Save All saves other tabs when one file conflicts and allows retrying', async ({ page }) => {
  await nativeBridge(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('test-other-file', 'other original'));
  const fileMenu = page.getByRole('button', { name: 'File', exact: true });
  await fileMenu.click();
  await page.getByRole('menuitem', { name: 'Open folder…', exact: true }).click();
  const code = page.locator('.cm-content:visible');
  for (const name of ['main.py', 'other.py']) {
    await page.getByRole('button', { name, exact: true }).click();
    await code.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(' draft');
  }
  await page.evaluate(() => localStorage.setItem('test-disk-content', 'external edit'));
  await fileMenu.click();
  await page.getByRole('menuitem', { name: 'Save All', exact: true }).click();
  const report = page.getByRole('alert');
  await expect(report).toContainText('Saved 1 file.');
  await expect(report).toContainText('main.py');
  const dirty = (name: string) => page.getByRole('tab', { name, exact: true }).locator('.dirty-dot');
  await expect(dirty('main.py')).toHaveCount(1);
  await expect(dirty('other.py')).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage.getItem('test-disk-content'), localStorage.getItem('test-other-file')])).toEqual(['external edit', 'other original draft']);

  await page.evaluate(() => localStorage.removeItem('test-disk-content'));
  await code.click();
  await page.keyboard.press('Control+Alt+s');
  await expect(page.getByRole('status')).toContainText('Saved 1 file.');
  await expect(dirty('main.py')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('test-disk-content'))).toBe('original disk content draft');
});

test('preserves existing line endings and saves explicit conversions', async ({ page }) => {
  await nativeBridge(page);
  await page.goto('/');
  const original = 'alpha\r\nbeta\ngamma';
  await page.evaluate(content => localStorage.setItem('test-disk-content', content), original);
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…', exact: true }).click();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  const endings = page.getByLabel('Line endings', { exact: true });
  const code = page.locator('.cm-content');
  const disk = () => page.evaluate(() => localStorage.getItem('test-disk-content'));
  await expect(endings).toHaveValue('Mixed');
  await code.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.insertText('changed ');
  await page.keyboard.press('Control+s');
  await expect.poll(disk).toBe('alpha\r\nchanged beta\ngamma');
  await endings.selectOption('CRLF');
  await expect(page.getByRole('tab', { name: 'main.py', exact: true }).locator('.dirty-dot')).toHaveCount(1);
  expect(await disk()).toBe('alpha\r\nchanged beta\ngamma');
  await code.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\ndelta');
  await page.keyboard.press('Control+s');
  await expect.poll(disk).toBe('alpha\r\nchanged beta\r\ngamma\r\ndelta');
  await endings.selectOption('LF');
  await page.keyboard.press('Control+s');
  await expect.poll(disk).toBe('alpha\nchanged beta\ngamma\ndelta');
});

test('edits a BOM file, saves with either UTF-8 encoding, and reopens from disk', async ({ page }) => {
  await nativeBridge(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('test-disk-content', '\uFEFFalpha\r\nbeta'));
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open folder…', exact: true }).click();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  const code = page.locator('.cm-content');
  const disk = () => page.evaluate(() => localStorage.getItem('test-disk-content'));
  const encoding = page.getByRole('button', { name: /^File encoding:/ });
  const choose = async (action: string) => {
    await encoding.click();
    await page.getByRole('menuitem', { name: action, exact: true }).click();
  };
  await expect(encoding).toHaveText('UTF-8 with BOM');
  await expect(code.locator('.cm-line').first()).toHaveText('alpha');
  await code.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('edited ');
  await page.keyboard.press('Control+s');
  await expect.poll(disk).toBe('\uFEFFedited alpha\r\nbeta');
  await choose('Save as UTF-8');
  await expect(encoding).toHaveText('UTF-8');
  await expect.poll(disk).toBe('edited alpha\r\nbeta');
  await choose('Save as UTF-8 with BOM');
  await expect(encoding).toHaveText('UTF-8 with BOM');
  await expect.poll(disk).toBe('\uFEFFedited alpha\r\nbeta');

  await code.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' draft');
  await page.evaluate(() => {
    localStorage.setItem('test-disk-content', 'external edit');
    localStorage.setItem('test-confirm', 'cancel');
  });
  await choose('Reopen from disk');
  await expect(encoding).toBeEnabled();
  await expect(code).toContainText('beta draft');
  await page.evaluate(() => localStorage.removeItem('test-confirm'));
  await choose('Reopen from disk');
  await expect(code).toHaveText('external edit');
  await expect(encoding).toHaveText('UTF-8');
  expect(await disk()).toBe('external edit');
});

test('keeps recovery buffers when a project folder cannot be reopened', async ({ page }) => {
  await nativeBridge(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'No folder open', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
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

test('switches recent projects without a folder dialog and persists their order', async ({ page }) => {
  await nativeBridge(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'No folder open', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Recent projects' })).toContainText('No recent projects yet');
  expect(await page.evaluate(() => localStorage.getItem('test-picker-count'))).toBeNull();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  await page.evaluate(() => localStorage.setItem('test-next-project', 'C:\\other\\project'));
  await page.locator('.project-picker').click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Recent projects…', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Recent projects' })).toBeVisible();
  await expect(page.getByRole('menuitem')).toHaveCount(3);
  await page.getByRole('menuitem').filter({ hasText: 'C:\\project' }).click();
  expect(await page.evaluate(() => localStorage.getItem('test-picker-count'))).toBe('2');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('leve.projects.v1') || '[]'))).toEqual(['C:\\project', 'C:\\other\\project']);
  await page.reload();
  await page.locator('.project-picker').click();
  await expect(page.getByRole('menuitem').nth(0)).toContainText('C:\\project');
  await expect(page.getByRole('menuitem').nth(1)).toContainText('C:\\other\\project');
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Open another folder…' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('.project-picker')).toBeFocused();
});

test('cancelled and failed project switches preserve the current edits and history', async ({ page }) => {
  await nativeBridge(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('leve.projects.v1', JSON.stringify(['C:\\other'])));
  await page.reload();
  await page.locator('.project-picker').click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('keep my draft ');
  await page.evaluate(() => localStorage.setItem('test-confirm', 'cancel'));
  await page.locator('.project-picker').click();
  await page.getByRole('menuitem').filter({ hasText: 'C:\\other' }).click();
  await expect(page.locator('.cm-content')).toContainText('keep my draft');
  await page.evaluate(() => { localStorage.removeItem('test-confirm'); localStorage.setItem('test-project-missing', 'true'); });
  await page.locator('.project-picker').click();
  await page.getByRole('menuitem').filter({ hasText: 'C:\\other' }).click();
  await expect(page.getByRole('status')).toContainText('Could not open project');
  await expect(page.locator('.cm-content')).toContainText('keep my draft');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('leve.projects.v1') || '[]'))).toEqual(['C:\\project', 'C:\\other']);
});
