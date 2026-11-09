import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => { await page.close({ runBeforeUnload: false }); });

test('decorates nested Git changes and opens diffs without changing a dirty editor tab', async ({ page }) => {
  await page.addInitScript(() => {
    const root = 'C:\\git-project';
    let callback = 0;
    let saved = false;
    let branch = 'main';
    let stagedFile = true;
    let workingFile = true;
    let stagedNew = false;
    let committedNew = false;
    let published = false;
    let fetched = false;
    let pulled = false;
    let pushAttempts = 0;
    const commit = '1234567890123456789012345678901234567890';
    const newCommit = '2345678901234567890123456789012345678901';
    const fixture = { initialized: false, switchCalls: 0, commitCalls: 0, longLists: false };
    Object.assign(window, { gitFixture: fixture, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command: string, args: { expectedRoot?: string; path?: string; kind?: string; repo?: string; branch?: string; head?: string; commit?: string; action?: string; paths?: string[]; request?: { branch: string; head: string; operation?: string; remote?: string; message?: string; paths?: string[]; publish?: boolean; target?: { remote: string; reference: string } } } = {}) => {
        if (command === 'session_load') return null;
        if (command === 'list_shells') return [];
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:dialog|open' || command === 'set_workspace') return root;
        if (command === 'list_directory') return args.path === ''
          ? [{ name: 'app', path: 'app', directory: true }]
          : [{ name: 'file.txt', path: 'app/file.txt', directory: false }, { name: 'new.txt', path: 'app/new.txt', directory: false }];
        if (command === 'read_file') return branch === 'main' ? 'working\n' : pulled ? 'pulled branch content\n' : 'feature branch content\n';
        if (command === 'write_file') { saved = true; return; }
        if (command === 'git_status') {
          if (args.expectedRoot !== root) throw new Error('Unexpected workspace');
          if (!fixture.initialized) return [];
          const featureChanges = fixture.longLists ? Array.from({ length: 50 }, (_, index) => ({ path: `app/change-${index}.txt`, status: 'M', kind: 'working' })) : [];
          return [{ id: 'app', branch, head: branch === 'main' && committedNew ? newCommit : commit, canSwitch: true, changes: branch !== 'main' ? featureChanges : [
            ...(stagedFile ? [{ path: 'app/file.txt', status: 'M', kind: 'staged' }] : []),
            ...(workingFile ? [{ path: 'app/file.txt', status: 'M', kind: 'working' }] : []),
            ...(!committedNew ? [{ path: 'app/new.txt', status: stagedNew ? 'A' : '?', kind: stagedNew ? 'staged' : 'untracked' }] : []),
            ...(saved ? [{ path: 'app/saved.txt', status: '?', kind: 'untracked' }] : []),
          ] }, { id: 'tools', branch: 'tooling', head: commit, canSwitch: true, changes: [] }];
        }
        if (command === 'git_update_index') {
          if (args.expectedRoot !== root || args.repo !== 'app' || !args.paths?.length) throw new Error('Unexpected staging request');
          const stage = args.action === 'stage';
          for (const path of args.paths) {
            if (path === 'app/new.txt') stagedNew = stage;
            else if (path === 'app/file.txt') { stagedFile = stage; workingFile = !stage; }
            else throw new Error('Unexpected staging path');
          }
          return;
        }
        if (command === 'git_branches') {
          if (args.repo !== 'app') throw new Error('Unexpected branch repository');
          return ['main', 'feature/branch'];
        }
        if (command === 'git_remote_status') {
          if (args.repo !== 'app' || args.branch !== 'feature/branch') return { remotes: [], upstream: null };
          return { remotes: ['backup', 'origin'], upstream: published ? { remote: 'backup', reference: 'refs/heads/feature/branch' } : null, comparison: published ? { ahead: 0, behind: fetched && !pulled ? 2 : 0 } : null };
        }
        if (command === 'git_push') {
          if (args.expectedRoot !== root || args.repo !== 'app' || args.request?.branch !== 'feature/branch' || args.request.head !== commit || args.request.target?.remote !== 'backup' || args.request.target.reference !== 'refs/heads/feature/branch' || args.request.publish === published) throw new Error('Unexpected push request');
          if (args.request.publish) published = true;
          else if (++pushAttempts === 1) throw new Error('non-fast-forward');
          return;
        }
        if (command === 'git_switch') {
          if (args.repo !== 'app' || args.branch !== 'feature/branch') throw new Error('Unexpected branch switch');
          fixture.switchCalls += 1;
          branch = args.branch;
          return;
        }
        if (command === 'git_receive') {
          if (args.expectedRoot !== root || args.repo !== 'app') throw new Error('Unexpected receive request');
          const request = args.request;
          if (request?.operation === 'fetch' && request.remote === 'backup') { fetched = true; return; }
          if (request?.operation === 'pull' && request.branch === 'feature/branch' && request.head === commit && request.target?.remote === 'backup' && request.target.reference === 'refs/heads/feature/branch') {
            pulled = true;
            return;
          }
          throw new Error('Unexpected receive target');
        }
        if (command === 'git_create_commit') {
          if (args.expectedRoot !== root || args.repo !== 'app' || !stagedNew || args.request?.branch !== 'main' || args.request.head !== commit || args.request.message !== 'Registra alterações\n\n#123 Detalhes' || args.request.paths?.join() !== 'app/new.txt') throw new Error('Unexpected commit request');
          fixture.commitCalls += 1;
          if (fixture.commitCalls === 1) throw new Error('Commit rejected by Git');
          stagedNew = false;
          committedNew = true;
          return;
        }
        if (command === 'git_history') {
          if (args.repo === 'app' && args.head === newCommit) return { commits: [{ id: newCommit, subject: 'Registra alterações', author: 'LEVE', date: 1700000001 }], hasMore: false };
          if (args.repo !== 'app' || args.head !== commit) throw new Error('Unexpected history request');
          const older = fixture.longLists ? Array.from({ length: 29 }, (_, index) => ({ id: String(index).padStart(40, '0'), subject: `Earlier commit ${index}`, author: 'LEVE', date: 1699999999 - index })) : [];
          return { commits: [{ id: commit, subject: 'Add branch content', author: 'LEVE', date: 1700000000 }, ...older], hasMore: false };
        }
        if (command === 'git_commit_files' && args.commit === commit) return ['file.txt'];
        if (command === 'git_commit_diff' && args.commit === commit && args.path === 'file.txt') return '@@ -1 +1 @@\n-working\n+feature branch content\n';
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
  await git.getByRole('region', { name: 'Staged changes' }).getByRole('button', { name: 'View diff for app/file.txt' }).click();
  await expect(page.getByRole('region', { name: 'Git diff' })).toContainText('Loading diff');
  await git.getByRole('region', { name: 'Working tree changes' }).getByRole('button', { name: 'View diff for app/file.txt' }).click();
  const patch = page.getByLabel('Unified diff');
  await expect(patch.locator('.git-addition')).toHaveText('+working');
  await expect(patch.locator('.git-deletion')).toHaveText('-staged');
  await expect.poll(() => page.evaluate(() => 'stagedDiffFinished' in window)).toBe(true);
  await expect(patch.locator('.git-addition')).toHaveText('+working');
  const diffTab = page.getByRole('tab', { name: 'file.txt (Git diff)', exact: true });
  await expect(diffTab).toHaveCount(1);
  await diffTab.locator('.flexlayout__tab_button_trailing').click();
  await expect(editor).toContainText('draft');
  await git.getByLabel('Repository').selectOption('tools');
  await expect(git.getByRole('button', { name: 'Switch branch (current: tooling)' })).toBeVisible();
  await expect(git.getByRole('status')).toHaveText('Working tree is clean.');
  const stagingActions = git.getByRole('button', { name: 'Staging actions' });
  await stagingActions.click();
  await expect(git.getByRole('button', { name: 'Stage All', exact: true })).toBeDisabled();
  await expect(git.getByRole('button', { name: 'Unstage All', exact: true })).toBeDisabled();
  await git.getByLabel('Repository').selectOption('app');
  await git.getByRole('button', { name: 'Stage app/new.txt', exact: true }).click();
  const staged = git.getByRole('region', { name: 'Staged changes' });
  await expect(staged.getByRole('button', { name: 'Unstage app/new.txt', exact: true })).toBeVisible();
  await staged.getByRole('button', { name: 'Unstage app/new.txt', exact: true }).click();
  await expect(git.getByRole('button', { name: 'Stage app/new.txt', exact: true })).toBeVisible();
  await stagingActions.click();
  await git.getByRole('button', { name: 'Stage All', exact: true }).click();
  await expect(staged.getByRole('button', { name: 'Unstage app/new.txt', exact: true })).toBeVisible();
  await expect(git.getByRole('region', { name: 'Working tree changes' })).toHaveCount(0);
  await stagingActions.click();
  await git.getByRole('button', { name: 'Unstage All', exact: true }).click();
  await expect(staged).toHaveCount(0);
  await expect(git.getByRole('button', { name: 'Stage app/new.txt', exact: true })).toBeVisible();
  await expect(editor).toContainText('draft');
  const commitMessage = git.getByRole('textbox', { name: 'Commit message' });
  const commitButton = git.getByRole('button', { name: 'Commit', exact: true });
  await commitMessage.fill('Registra alterações\n\n#123 Detalhes');
  await expect(commitButton).toBeDisabled();
  await git.getByRole('button', { name: 'Stage app/new.txt', exact: true }).click();
  await commitButton.click();
  await expect(git.getByRole('alert')).toContainText('Commit rejected by Git');
  await expect(commitMessage).toHaveValue('Registra alterações\n\n#123 Detalhes');
  await commitButton.click();
  await expect(commitMessage).toHaveValue('');
  await expect(staged).toHaveCount(0);
  await expect(editor).toContainText('draft');
  await git.getByRole('button', { name: 'History', exact: true }).click();
  await expect(git.getByRole('button', { name: /Registra alterações/ })).toBeVisible();
  await git.getByRole('button', { name: 'Changes', exact: true }).click();
  const switchButton = git.getByRole('button', { name: 'Switch branch (current: main)' });
  await switchButton.click();
  await git.getByLabel('Search local branches').fill('feature');
  await git.getByRole('button', { name: 'feature/branch', exact: true }).click();
  await expect(git.getByRole('alert')).toContainText('Save your open edits');
  expect(await page.evaluate(() => (window as Window & { gitFixture: { switchCalls: number } }).gitFixture.switchCalls)).toBe(0);
  await editor.click();
  await page.keyboard.press('Control+s');
  await expect(git.getByRole('region', { name: 'Untracked files' })).toContainText('saved.txt');
  await git.getByLabel('Search local branches').press('Enter');
  await expect(git.getByRole('button', { name: 'Switch branch (current: feature/branch)' })).toBeVisible();
  await expect(git.getByRole('status')).toHaveText('Working tree is clean.');
  await expect(editor).toContainText('feature branch content');
  const publishBranch = git.getByRole('button', { name: 'Publish Branch' });
  await expect(publishBranch).toBeDisabled();
  await git.getByLabel('Push remote').selectOption('backup');
  await publishBranch.click();
  await expect(git.getByText('Published to backup/feature/branch.')).toBeVisible();
  const push = git.getByRole('button', { name: 'Push', exact: true });
  await push.click();
  await expect(git.getByRole('alert')).toContainText('non-fast-forward');
  await push.click();
  await expect(git.getByText('Pushed to backup/feature/branch.')).toBeVisible();
  await expect(git.getByText('Up to date with upstream')).toBeVisible();
  await git.getByRole('button', { name: 'Fetch', exact: true }).click();
  await expect(git.getByText('Fetched from backup.')).toBeVisible();
  await expect(git.getByText('0 ahead · 2 behind')).toBeVisible();
  await expect(editor).toContainText('feature branch content');
  await git.getByRole('button', { name: 'Pull', exact: true }).click();
  await expect(git.getByText('Checked for updates from backup/feature/branch.')).toBeVisible();
  await expect(git.getByText('Up to date with upstream')).toBeVisible();
  await expect(editor).toContainText('pulled branch content');
  await page.evaluate(() => { (window as Window & { gitFixture: { longLists: boolean } }).gitFixture.longLists = true; });
  const gitResults = git.getByRole('region', { name: 'Git results', exact: true });
  const branchControl = git.getByRole('button', { name: 'Switch branch (current: feature/branch)' });
  const history = git.getByRole('button', { name: 'History', exact: true });
  await git.getByRole('button', { name: 'Refresh Git changes' }).click();
  await expect(gitResults.getByRole('button', { name: 'View diff for app/change-49.txt' })).toHaveCount(1);
  const commitMessagePosition = await commitMessage.boundingBox();
  const branchPosition = await branchControl.boundingBox();
  const historyPosition = await history.boundingBox();
  await gitResults.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => gitResults.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await commitMessage.boundingBox()).toEqual(commitMessagePosition);
  expect(await branchControl.boundingBox()).toEqual(branchPosition);
  expect(await history.boundingBox()).toEqual(historyPosition);
  await git.getByRole('button', { name: 'History', exact: true }).click();
  await expect(gitResults.getByRole('button', { name: /Earlier commit 28/ })).toHaveCount(1);
  await expect.poll(() => gitResults.evaluate(element => element.scrollTop)).toBe(0);
  await gitResults.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => gitResults.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await branchControl.boundingBox()).toEqual(branchPosition);
  expect(await history.boundingBox()).toEqual(historyPosition);
  await git.getByRole('button', { name: /Add branch content/ }).click();
  const commitView = page.getByRole('region', { name: 'Git commit', exact: true });
  await expect(commitView.getByLabel('Changed files (1)')).toHaveValue('file.txt');
  await expect(commitView.getByLabel('Unified diff').locator('.git-addition')).toHaveText('+feature branch content');
});
