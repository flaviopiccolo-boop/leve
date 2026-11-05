import { expect, test, type Locator, type Page } from '@playwright/test';

async function dragTab(page: Page, tab: Locator, x: number, y: number) {
  const from = (await tab.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 20 });
  await page.mouse.up();
}

async function viewAction(page: Page, name: string) {
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menu', { name: 'View', exact: true }).getByRole('menuitem', { name, exact: true }).click();
}

test.afterEach(async ({ page }) => {
  // Keep the browser's unsaved-changes prompt out of test teardown.
  await page.keyboard.press('Control+s');
});

test('starts with the explorer on the left and terminals below the editor', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Room to create.' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /PowerShell|CMD|Git Bash/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Start / })).toHaveCount(0);
  const tree = await page.locator('.explorer').boundingBox();
  const editor = await page.locator('.welcome').boundingBox();
  const terminal = await page.getByRole('button', { name: 'New terminal', exact: true }).filter({ has: page.locator('svg.lucide-plus') }).boundingBox();
  expect(tree!.x).toBeLessThan(editor!.x);
  expect(terminal!.y).toBeGreaterThan(editor!.y);
  await page.screenshot({ path: 'artifacts/leve-preview.png' });
  expect(errors).toEqual([]);
});

test('edits a file, marks it dirty, saves and preserves the session content after reopening', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  const code = page.locator('.cm-content');
  await expect(code).toContainText('from services.greeting import greet');
  await code.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n# edited file');
  await expect(page.getByRole('tab', { name: 'main.py', exact: true }).locator('.dirty-dot')).toHaveCount(1);
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('tab', { name: 'main.py', exact: true }).locator('.dirty-dot')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('saved only in this demo');
  const tab = page.getByRole('tab', { name: 'main.py', exact: true });
  await tab.locator('.flexlayout__tab_button_trailing').click();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('# edited file');
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.screenshot({ path: 'artifacts/leve-code.png' });
});

test('finds nested files through Ctrl+P', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.statusbar')).toContainText('Recovery saved');
  await page.keyboard.press('Control+p');
  await expect(page.locator('#file-search')).toBeFocused();
  await page.locator('#file-search').fill('greeting');
  await page.locator('.search-result').click();
  await expect(page.locator('.cm-content')).toContainText('def greet(name: str)');
});

test('preserves unsaved content when closing is cancelled', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n# keep this change');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('tab', { name: 'main.py', exact: true }).locator('.flexlayout__tab_button_trailing').click();
  await expect(page.locator('.cm-content')).toContainText('# keep this change');
  await expect(page.getByRole('tab', { name: 'main.py', exact: true }).locator('.dirty-dot')).toHaveCount(1);
});

test('the tab context menu closes the clicked file and respects unsaved changes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n# unsaved draft');
  const file = page.getByRole('tab', { name: 'main.py', exact: true });
  const welcome = page.getByRole('tab', { name: 'Welcome', exact: true });
  await welcome.click();
  await file.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Tab actions' });
  await expect(menu.getByRole('menuitem', { name: 'Close tab' })).toBeFocused();
  await expect(welcome).toHaveAttribute('aria-selected', 'true');
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Enter');
  await expect(file.locator('.dirty-dot')).toBeVisible();
  await expect(menu).toHaveCount(0);
  await file.click({ button: 'right' });
  page.once('dialog', dialog => dialog.accept());
  await menu.getByRole('menuitem', { name: 'Close tab' }).click();
  await expect(file).toHaveCount(0);
  await expect(welcome).toBeVisible();
});

test('middle click closes a terminal but leaves protected tabs open', async ({ page }) => {
  await page.goto('/');
  for (const name of ['Explorer', 'Search', 'Git', 'Welcome', 'Problems']) {
    const tab = page.getByRole('tab', { name: new RegExp(`^${name}\\b`) });
    await tab.click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Tab actions' })).toHaveCount(0);
    await tab.click({ button: 'middle' });
    await expect(tab).toBeVisible();
  }
  await page.getByRole('button', { name: 'New terminal', exact: true }).filter({ has: page.locator('svg.lucide-plus') }).click();
  await page.getByRole('menuitem', { name: 'PowerShell', exact: true }).click();
  const terminal = page.getByRole('tab', { name: 'PowerShell', exact: true });
  await terminal.click({ button: 'middle' });
  await expect(terminal).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Problems' })).toBeVisible();
});

test('moves the explorer to the right and restores the saved layout on reload', async ({ page }) => {
  await page.goto('/');
  const tab = page.getByRole('tab', { name: 'Explorer', exact: true });
  const editor = await page.locator('.welcome').boundingBox();
  await dragTab(page, tab, editor!.x + editor!.width - 25, editor!.y + editor!.height / 2);
  const explorer = await page.locator('.explorer').boundingBox();
  const welcome = await page.locator('.welcome').boundingBox();
  expect(explorer!.x).toBeGreaterThan(welcome!.x);
  await page.reload();
  const restoredExplorer = await page.locator('.explorer').boundingBox();
  const restoredEditor = await page.locator('.welcome').boundingBox();
  expect(restoredExplorer!.x).toBeGreaterThan(restoredEditor!.x);
});

test('reclaims the space of a split when its last file is closed while maximized', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  const file = page.getByRole('tab', { name: 'main.py', exact: true });
  const groups = page.locator('.flexlayout__tabset');
  await expect(page.locator('.cm-editor')).toBeVisible();
  const editor = (await page.locator('.cm-editor').boundingBox())!;
  await dragTab(page, file, editor.x + editor.width / 2, editor.y + 25);
  await expect(groups).toHaveCount(4);

  const split = groups.filter({ has: file });
  await split.getByRole('button', { name: 'Maximize tabset', exact: true }).click();
  await expect(split.getByRole('button', { name: 'Restore tabset', exact: true })).toBeVisible();
  await file.locator('.flexlayout__tab_button_trailing').click();
  await expect(groups).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Room to create.' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Problems' })).toBeVisible();
});

test('recovers panels from a maximized Welcome using the activity bar or View', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.flexlayout__tabset').filter({ has: page.getByRole('tab', { name: 'Welcome', exact: true }) });
  const maximize = editor.getByRole('button', { name: 'Maximize tabset', exact: true });
  await maximize.click();
  await expect(page.locator('.explorer')).toBeHidden();
  await page.getByRole('button', { name: 'Explorer', exact: true }).click();
  await expect(page.locator('.explorer')).toBeVisible();
  await maximize.click();
  await viewAction(page, 'Restore workspace');
  await expect(page.locator('.explorer')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Problems' })).toBeVisible();
  await expect(maximize).toBeVisible();
});

test('the title bar collapses the sidebar and restores its selected tab', async ({ page }) => {
  await page.goto('/');
  await viewAction(page, 'Hide Git');
  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  const editor = page.locator('.welcome');
  const originalWidth = (await editor.boundingBox())!.width;

  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(page.getByRole('tab', { name: 'Search', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Problems' })).toBeVisible();
  await expect.poll(async () => (await editor.boundingBox())!.width).toBeGreaterThan(originalWidth);

  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(page.getByRole('tab', { name: 'Search', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Git', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveAttribute('aria-expanded', 'true');
});

test('restores hidden panels after a reload without losing the open editor', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  for (const panel of ['Explorer', 'Search', 'Git', 'Problems']) await viewAction(page, `Hide ${panel}`);
  await expect(page.locator('.flexlayout__tabset')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('leve.session.v1') || '{}').layout?.borders?.[0]?.children?.length)).toBe(4);
  await page.reload();
  await expect(page.locator('.flexlayout__tabset')).toHaveCount(1);
  await expect(page.locator('.cm-content')).toContainText('from services.greeting import greet');
  await viewAction(page, 'Restore workspace');
  await expect(page.locator('.flexlayout__tabset')).toHaveCount(3);
  await expect(page.locator('.explorer')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Problems' })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('from services.greeting import greet');
});

test('removes the original editor area when its last tab is moved and opens files beside Welcome', async ({ page }) => {
  await page.goto('/');
  const welcome = page.getByRole('tab', { name: 'Welcome', exact: true });
  const explorer = (await page.locator('.explorer').boundingBox())!;
  await dragTab(page, welcome, explorer.x + explorer.width / 2, explorer.y + explorer.height / 2);
  await expect(page.locator('.flexlayout__tabset')).toHaveCount(2);
  await expect(welcome).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Explorer', exact: true }).click();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('from services.greeting import greet');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('leve.session.v1') || '{}').files?.length)).toBe(1);
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('from services.greeting import greet');
  await expect(page.locator('.flexlayout__tabset')).toHaveCount(2);
});

test('cleans up an empty split from a saved layout made before automatic removal', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('leve.layout.v1', JSON.stringify({
      global: { tabSetEnableClose: false },
      layout: { type: 'row', children: [
        { type: 'tabset', children: [
          { type: 'tab', id: 'explorer', component: 'explorer', name: 'Explorer', enableClose: false },
          { type: 'tab', id: 'search', component: 'search', name: 'Search', enableClose: false },
        ] },
        { type: 'tabset', id: 'documents', children: [
          { type: 'tab', id: 'welcome', component: 'welcome', name: 'Welcome', enableClose: false },
        ] },
        { type: 'tabset', id: 'old-split', enableDeleteWhenEmpty: false, children: [] },
      ] },
    }));
  });
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Git', exact: true })).toBeVisible();
  await expect(page.locator('.flexlayout__tabset')).toHaveCount(2);
});

test('removes the original terminal area when emptied and keeps the terminal picker available', async ({ page }) => {
  await page.goto('/');
  const plus = page.getByRole('button', { name: 'New terminal', exact: true }).filter({ has: page.locator('svg.lucide-plus') });
  const terminal = page.getByRole('tab', { name: 'PowerShell', exact: true });
  const problems = page.getByRole('tab', { name: 'Problems' });
  await plus.click();
  await page.getByRole('menuitem', { name: 'PowerShell', exact: true }).click();
  const editor = (await page.locator('.welcome').boundingBox())!;
  await dragTab(page, problems, editor.x + editor.width / 2, editor.y + 25);
  const groups = page.locator('.flexlayout__tabset');
  await expect(groups).toHaveCount(4);
  await terminal.locator('.flexlayout__tab_button_trailing').click();
  await expect(groups).toHaveCount(3);
  await groups.filter({ has: problems }).locator(plus).click();
  await page.getByRole('menuitem', { name: 'PowerShell', exact: true }).click();
  await expect(groups.filter({ has: problems }).locator(terminal)).toBeVisible();
});

test('updates built-in labels in layouts saved by older versions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  await page.evaluate(() => {
    const layout = JSON.parse(localStorage.getItem('leve.layout.v1')!);
    const legacyNames: Record<string, string> = { explorer: 'Explorador', search: 'Pesquisa', welcome: 'Bem-vindo' };
    const rename = (node: { component?: string; name?: string; children?: any[] }) => {
      if (node.component && legacyNames[node.component]) node.name = legacyNames[node.component];
      node.children?.forEach(rename);
    };
    rename(layout.layout);
    localStorage.setItem('leve.layout.v1', JSON.stringify(layout));
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Explorer', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Search', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
});

test('switches themes without losing edits or undo history and saves the preference', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.activity-bar')).toHaveCSS('background-color', 'rgb(39, 40, 44)');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  const code = page.locator('.cm-content');
  await code.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n# preserve theme change');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Light', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(code).toContainText('# preserve theme change');
  await expect(page.locator('.cm-editor')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.activity-bar')).toHaveCSS('background-color', 'rgb(238, 245, 249)');
  await expect(page.getByRole('button', { name: 'main.py', exact: true })).toHaveCSS('color', 'rgb(48, 55, 61)');
  await code.click();
  await page.keyboard.press('Control+z');
  await expect(code).not.toContainText('# preserve theme change');
  await page.screenshot({ path: 'artifacts/leve-light.png' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Light', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('preset themes recolor the open editor and terminal and survive a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  const plus = page.getByRole('button', { name: 'New terminal', exact: true }).filter({ has: page.locator('svg.lucide-plus') });
  await plus.click();
  await page.getByRole('menuitem', { name: 'CMD', exact: true }).click();
  const editor = page.locator('.cm-editor');
  const terminal = page.locator('.xterm-scrollable-element');
  await expect(terminal).toHaveCSS('background-color', 'rgb(24, 25, 28)');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Midnight', exact: true }).check();
  await expect(editor).toHaveCSS('background-color', 'rgb(12, 21, 36)');
  await expect(terminal).toHaveCSS('background-color', 'rgb(10, 19, 32)');
  await page.getByRole('radio', { name: 'Paper', exact: true }).check();
  await expect(editor).toHaveCSS('background-color', 'rgb(255, 251, 241)');
  await expect(terminal).toHaveCSS('background-color', 'rgb(251, 244, 231)');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Paper', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
});

test('settings switch between sections and search for language options', async ({ page }) => {
  await page.goto('/');
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
  await settingsButton.click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Workspace layout' }).click();
  await expect(dialog.getByRole('button', { name: 'Reset layout' })).toBeVisible();
  const search = dialog.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('typescript');
  await expect(dialog.getByRole('button', { name: 'Language support' })).toHaveAttribute('aria-current', 'page');
  await expect(dialog.getByRole('checkbox', { name: 'TypeScript', exact: true })).toBeDisabled();
  await search.clear();
  await dialog.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(dialog.getByText('Ctrl+Shift+F', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(settingsButton).toBeFocused();
});

test('Explorer preferences update the preview and persist in the project tree', async ({ page }) => {
  await page.goto('/');
  const tree = page.locator('.explorer-tree');
  await expect(tree.locator('.tree-name').first()).toHaveText('src');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'Explorer', exact: true }).click();
  const preview = dialog.getByRole('region', { name: 'Explorer preview' });
  const style = dialog.getByLabel('File icon style');
  await style.selectOption('colorful');
  const pythonIcon = preview.getByText('main.py', { exact: true }).locator('..').locator('.tree-entry-icon');
  await expect(pythonIcon).toHaveClass(/tree-icon-blue/);
  await expect(preview.getByText('settings.json', { exact: true }).locator('..').locator('.tree-entry-icon')).toHaveClass(/lucide-file-json2/);
  await style.selectOption('none');
  await expect(preview.locator('.tree-entry-icon')).toHaveCount(0);
  await expect(preview.locator('.tree-chevron')).toBeVisible();
  await style.selectOption('monochrome');
  await expect(pythonIcon).toHaveClass(/file-icon/);
  await dialog.getByLabel('Row density').selectOption('compact');
  await dialog.getByRole('checkbox', { name: 'Indent guides' }).check();
  await dialog.getByRole('checkbox', { name: 'Folders first' }).uncheck();
  await dialog.getByRole('checkbox', { name: 'Git indicators' }).uncheck();
  await expect(preview.locator('.tree-name').first()).toHaveText('logo.png');
  await expect(preview.locator('.tree-git-badge')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close settings' }).click();

  await expect(tree.locator('.tree-name').first()).toHaveText('.gitignore');
  await page.reload();
  const main = tree.getByRole('button', { name: 'main.py', exact: true });
  await expect(main).toHaveCSS('height', '23px');
  await expect(main.locator('.tree-entry-icon')).toHaveClass(/file-icon/);
  await expect(tree).toHaveAttribute('data-indent-guides', 'true');
});

test('the plus button opens a shell picker and creates the selected terminal tab', async ({ page }) => {
  await page.goto('/');
  const plus = page.getByRole('button', { name: 'New terminal', exact: true }).filter({ has: page.locator('svg.lucide-plus') });
  await plus.click();
  await expect(page.getByRole('menu', { name: 'New terminal' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'CMD', exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'CMD', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'CMD', exact: true }).locator('.xterm')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Start / })).toHaveCount(0);
  await plus.click();
  await page.getByRole('menuitem', { name: 'Git Bash', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Git Bash', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'CMD', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Git Bash', exact: true })).toHaveCount(0);
});

test('desktop shell selection starts immediately and keeps other terminal sessions open', async ({ page }) => {
  await page.addInitScript(() => {
    const starts: string[] = [];
    const closes: string[] = [];
    const failures = { next: false };
    let callbackId = 0;
    Object.assign(window, {
      isTauri: true,
      shellCalls: { starts, closes, failures },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => ++callbackId,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'list_shells') return [
            { id: 'powershell', name: 'PowerShell', available: true },
            { id: 'cmd', name: 'CMD', available: true },
            { id: 'git-bash', name: 'Git Bash', available: true },
            { id: 'pwsh', name: 'PowerShell 7', available: false },
          ];
          if (command === 'plugin:dialog|open' || command === 'set_workspace') return 'C:\\test-project';
          if (command === 'list_directory') return [];
          if (command === 'plugin:event|listen') return 1;
          if (command === 'terminal_start') {
            starts.push(String(args.shellId));
            if (failures.next) throw new Error('Shell startup failed');
          }
          if (command === 'terminal_close') closes.push(String(args.id));
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /PowerShell|CMD|Git Bash/ })).toHaveCount(0);
  const plus = page.getByRole('button', { name: 'New terminal', exact: true }).filter({ has: page.locator('svg.lucide-plus') });
  await plus.click();
  await expect(page.getByRole('menuitem', { name: 'PowerShell 7 Not installed' })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'CMD', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'CMD', exact: true }).locator('.xterm')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Start / })).toHaveCount(0);
  await plus.click();
  await page.getByRole('menuitem', { name: 'Git Bash', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Git Bash', exact: true }).locator('.xterm')).toBeVisible();
  await viewAction(page, 'Hide Terminal');
  await expect(page.getByRole('tab', { name: /CMD|Git Bash/ })).toHaveCount(0);
  await viewAction(page, 'Show Terminal');
  await expect(page.getByRole('tab', { name: 'Git Bash', exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'CMD', exact: true }).locator('.xterm')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { shellCalls: { starts: string[] } }).shellCalls.starts)).toEqual(['cmd', 'git-bash']);
  expect(await page.evaluate(() => (window as unknown as { shellCalls: { closes: string[] } }).shellCalls.closes)).toEqual([]);
  await page.evaluate(() => { (window as unknown as { shellCalls: { failures: { next: boolean } } }).shellCalls.failures.next = true; });
  await plus.click();
  await page.getByRole('menuitem', { name: 'PowerShell', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Shell startup failed');
  await expect(page.getByRole('button', { name: /^Start / })).toHaveCount(0);
});

test('the desktop title bar controls the window and closes through session recovery', async ({ page }) => {
  await page.addInitScript(() => {
    let maximized = false;
    let callbackId = 0;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number>();
    const calls: string[] = [];
    Object.assign(window, { isTauri: true, windowCalls: calls, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; },
      unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (command === 'list_shells') return [];
        if (command === 'session_load') return null;
        if (command === 'plugin:event|listen') {
          listeners.set(args.event, args.handler);
          return args.handler;
        }
        if (command === 'plugin:window|is_maximized') return maximized;
        calls.push(command);
        if (command === 'plugin:window|toggle_maximize') maximized = !maximized;
        if (command === 'plugin:window|close') {
          const id = listeners.get('tauri://close-requested');
          if (id != null) callbacks.get(id)?.({ id, event: 'tauri://close-requested', payload: null });
        }
      },
    } });
  });
  await page.goto('/');
  const header = page.getByRole('banner');
  await expect(header).toHaveAttribute('data-tauri-drag-region', '');
  await header.getByRole('button', { name: 'Minimize window' }).click();
  await header.getByRole('button', { name: 'Maximize window' }).click();
  await header.getByRole('button', { name: 'Restore window' }).click();
  await expect(header.getByRole('button', { name: 'Maximize window' })).toBeVisible();
  // Let the initial checkpoint finish before measuring the close sequence.
  await expect(page.getByText('Recovery saved', { exact: true })).toBeVisible();
  await page.evaluate(() => ((window as any).windowCalls as string[]).splice(0));
  await header.getByRole('button', { name: 'Close window' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).windowCalls)).toEqual([
    'plugin:window|close', 'session_save', 'plugin:window|destroy',
  ]);
});
