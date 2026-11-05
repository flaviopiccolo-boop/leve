import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => { await page.close({ runBeforeUnload: false }); });

test('decorates nested Git changes and opens diffs without changing a dirty editor tab', async ({ page }) => {
  await page.addInitScript(() => {
    const root = 'C:\\git-project';
    let callback = 0;
    let saved = false;
    const fixture = { initialized: false };
    Object.assign(window, { gitFixture: fixture, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command: string, args: { expectedRoot?: string; path?: string; kind?: string } = {}) => {
        if (command === 'session_load') return null;
        if (command === 'list_shells') return [];
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:dialog|open' || command === 'set_workspace') return root;
        if (command === 'list_directory') return args.path === ''
          ? [{ name: 'app', path: 'app', directory: true }]
          : [{ name: 'file.txt', path: 'app/file.txt', directory: false }, { name: 'new.txt', path: 'app/new.txt', directory: false }];
        if (command === 'read_file') return 'working\n';
        if (command === 'write_file') { saved = true; return; }
        if (command === 'git_status') {
          if (args.expectedRoot !== root) throw new Error('Unexpected workspace');
          if (!fixture.initialized) return null;
          return [
            { path: 'app/file.txt', status: 'M', kind: 'staged' },
            { path: 'app/file.txt', status: 'M', kind: 'working' },
            { path: 'app/new.txt', status: '?', kind: 'untracked' },
            ...(saved ? [{ path: 'app/saved.txt', status: '?', kind: 'untracked' }] : []),
          ];
        }
        if (command === 'git_diff') {
          if (args.expectedRoot !== root || args.path !== 'app/file.txt') throw new Error('Unexpected diff request');
          if (args.kind === 'staged') {
            await new Promise(resolve => setTimeout(resolve, 750));
            Object.assign(window, { stagedDiffFinished: true });
            return '@@ -1 +1 @@\n-original\n+staged\n';
          }
          return '@@ -1 +1 @@\n-staged\n+working\n';
        }
      },
    } });
  });
  await page.goto('/');
  await page.locator('.project-picker').click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  const gitButton = page.getByRole('button', { name: 'Git changes', exact: true });
  await gitButton.click();
  const git = page.getByRole('region', { name: 'Git changes', exact: true });
  await expect(git.getByRole('status')).toContainText('git init');
  await page.evaluate(() => { (window as Window & { gitFixture?: { initialized: boolean } }).gitFixture!.initialized = true; });
  await git.getByRole('button', { name: 'Refresh Git changes' }).click();
  await expect(git.getByRole('region', { name: 'Untracked files' })).toContainText('app/new.txt');
  await page.getByRole('button', { name: 'Explorer', exact: true }).click();
  const folder = page.getByRole('button', { name: 'app', exact: true });
  await expect(folder.locator('.tree-git-badge')).toHaveText('●');
  await folder.click();
  const changedFile = page.getByRole('button', { name: 'file.txt', exact: true });
  await expect(changedFile.locator('.tree-name')).toHaveCSS('color', 'rgb(226, 192, 141)');
  const untracked = page.getByRole('button', { name: 'new.txt', exact: true });
  await expect(untracked.locator('.tree-name')).toHaveCSS('color', 'rgb(115, 201, 145)');
  await expect(untracked.locator('.tree-git-badge')).toHaveText('U');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Explorer', exact: true }).click();
  await settings.getByRole('checkbox', { name: 'Git indicators' }).uncheck();
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await expect(folder.locator('.tree-git-badge')).toHaveCount(0);
  await expect(untracked.locator('.tree-name')).not.toHaveAttribute('data-git-status', '?');
  await changedFile.click();
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.insertText('draft ');
  await gitButton.click();
  await git.getByRole('region', { name: 'Staged changes' }).getByRole('button').click();
  await expect(page.getByRole('region', { name: 'Git diff' })).toContainText('Loading diff');
  await git.getByRole('region', { name: 'Working tree changes' }).getByRole('button').click();
  const patch = page.getByLabel('Unified diff');
  await expect(patch.locator('.git-addition')).toHaveText('+working');
  await expect(patch.locator('.git-deletion')).toHaveText('-staged');
  await expect.poll(() => page.evaluate(() => 'stagedDiffFinished' in window)).toBe(true);
  await expect(patch.locator('.git-addition')).toHaveText('+working');
  const diffTab = page.getByRole('tab', { name: 'file.txt (Git diff)', exact: true });
  await expect(diffTab).toHaveCount(1);
  await diffTab.locator('.flexlayout__tab_button_trailing').click();
  await expect(editor).toContainText('draft');
  await editor.click();
  await page.keyboard.press('Control+s');
  await expect(git.getByRole('region', { name: 'Untracked files' })).toContainText('saved.txt');
});
