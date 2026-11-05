import { expect, test } from '@playwright/test';

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

test('moves the explorer to the right and restores the saved layout on reload', async ({ page }) => {
  await page.goto('/');
  const tab = await page.locator('.flexlayout__tab_button').filter({ hasText: 'Explorer' }).boundingBox();
  const editor = await page.locator('.welcome').boundingBox();
  await page.mouse.move(tab!.x + tab!.width / 2, tab!.y + tab!.height / 2);
  await page.mouse.down();
  await page.mouse.move(editor!.x + editor!.width - 25, editor!.y + editor!.height / 2, { steps: 20 });
  await page.mouse.up();
  const explorer = await page.locator('.explorer').boundingBox();
  const welcome = await page.locator('.welcome').boundingBox();
  expect(explorer!.x).toBeGreaterThan(welcome!.x);
  await page.reload();
  const restoredExplorer = await page.locator('.explorer').boundingBox();
  const restoredEditor = await page.locator('.welcome').boundingBox();
  expect(restoredExplorer!.x).toBeGreaterThan(restoredEditor!.x);
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
  await page.evaluate(() => ((window as any).windowCalls as string[]).splice(0));
  await header.getByRole('button', { name: 'Close window' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).windowCalls)).toEqual([
    'plugin:window|close', 'session_save', 'plugin:window|destroy',
  ]);
});
