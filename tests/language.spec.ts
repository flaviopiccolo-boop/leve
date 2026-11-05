import { expect, test } from '@playwright/test';

test('shares the TypeScript server with JavaScript and integrates ESLint, completion and definition', async ({ page }) => {
  await page.addInitScript(() => {
    const root = 'C:\\language-fixture';
    const rootUri = 'file:///C:/language-fixture';
    const sources: Record<string, string> = {
      'main.ts': "import { greet } from './helper';\ngreet();",
      'helper.ts': '\nexport function greet() {}',
      'main.js': 'const value = 1;',
      'view.py': 'def view():\n    pass',
    };
    const calls = { starts: [] as string[], stops: [] as string[], opened: [] as string[], linted: [] as string[], copied: [] as string[], writes: 0, failPython: false };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { calls.copied.push(text); },
    } });
    const servers = new Map<string, { onmessage: (message: unknown) => void }>();
    let callback = 0;
    Object.assign(window, { languageCalls: calls, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        if (command === 'list_shells') return [];
        if (command === 'session_load') return null;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:dialog|open' || command === 'set_workspace') return root;
        if (command === 'list_directory') return Object.keys(sources).map(path => ({ name: path, path, directory: false }));
        if (command === 'read_file') return sources[args.path];
        if (command === 'write_file') { calls.writes++; sources[args.path] = args.content; return; }
        if (command === 'lsp_start') {
          calls.starts.push(args.kind);
          if (args.kind === 'python' && calls.failPython) throw new Error('Pyright was not found.');
          servers.set(args.id, args.output);
          return { rootUri, pythonPath: null };
        }
        if (command === 'lsp_stop') {
          calls.stops.push(args.kind);
          servers.delete(args.id);
          return;
        }
        if (command === 'lsp_document') return rootUri + '/' + args.path;
        if (command === 'lsp_resolve') return args.uri.slice(rootUri.length + 1);
        if (command === 'eslint_check') {
          calls.linted.push(args.content);
          if (args.path === 'helper.ts') return [];
          return [{ line: 2, column: 1, endLine: 2, endColumn: 6, severity: 1, message: 'Project lint warning', ruleId: 'fixture' }];
        }
        if (command === 'lsp_send') {
          const request = JSON.parse(args.message);
          const output = servers.get(args.id);
          const send = (message: object) => output?.onmessage({ kind: 'message', message: JSON.stringify({ jsonrpc: '2.0', ...message }) });
          if (request.method === 'initialize') send({
            id: request.id, result: { capabilities: { textDocumentSync: 2, completionProvider: {}, definitionProvider: true } },
          });
          if (request.method === 'textDocument/didOpen') {
            const { uri, languageId, version } = request.params.textDocument;
            calls.opened.push(languageId);
            if (uri.endsWith('main.ts')) send({
              method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics: [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
                severity: 1, source: 'TypeScript', message: 'Type mismatch',
              }] },
            });
          }
          if (request.method === 'textDocument/completion') send({
            id: request.id, result: [{ label: 'serverSuggestion', kind: 6 }],
          });
          if (request.method === 'textDocument/definition') send({
            id: request.id, result: [{ uri: rootUri + '/helper.ts', range: { start: { line: 1, character: 7 }, end: { line: 1, character: 15 } } }],
          });
        }
      },
    } });
  });

  await page.goto('/');
  await page.locator('.project-picker').click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  await page.getByRole('button', { name: 'main.ts', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  const calls = () => page.evaluate(() => (window as any).languageCalls);
  expect((await calls()).starts).toEqual([]);
  const editor = page.locator('.cm-content:visible');
  await editor.click();
  await page.keyboard.press('F12');
  await expect(page.getByText('Enable TypeScript in Settings → Language support to use Go to Definition.')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'TypeScript', exact: true }).check();
  await page.getByRole('checkbox', { name: 'ESLint', exact: true }).check();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect.poll(async () => (await calls()).opened).toEqual(['typescript']);
  await editor.click();
  await page.keyboard.press('Control+Shift+KeyM');
  const problems = page.getByRole('region', { name: 'File problems' });
  const problemsTab = page.getByRole('tab', { name: /Problems/ });
  await expect(problems).toContainText('TypeScript: Type mismatch');
  await expect(problems).toContainText('Project lint warning (fixture)');
  await expect(problemsTab).toHaveText('Problems 2');
  const problemRow = problems.getByRole('button', { name: /TypeScript: Type mismatch/ });
  await problemRow.click({ button: 'right' });
  const problemMenu = page.getByRole('menu', { name: 'Problem actions' });
  await problemMenu.getByRole('menuitem', { name: 'Expand details' }).click();
  await expect(problems.locator('.problem-details')).toContainText('"file": "main.ts"');
  await problemRow.click({ button: 'right' });
  await problemMenu.getByRole('menuitem', { name: 'Collapse details' }).click();
  await expect(problems.locator('.problem-details')).toHaveCount(0);
  await problemRow.press('Shift+F10');
  await problemMenu.getByRole('menuitem', { name: 'Copy problem' }).click();
  const fileGroup = problems.getByRole('button', { name: /main\.ts.*warning/ });
  await fileGroup.click({ button: 'right' });
  const fileProblemMenu = page.getByRole('menu', { name: 'File problem actions' });
  await fileProblemMenu.getByRole('menuitem', { name: 'Collapse group' }).click();
  await expect(problems.getByRole('button', { name: 'Copy problem', exact: true })).toHaveCount(0);
  await fileGroup.click({ button: 'right' });
  await fileProblemMenu.getByRole('menuitem', { name: 'Copy all' }).click();
  const copies = (await calls()).copied.map((text: string) => JSON.parse(text));
  expect(copies[0]).toMatchObject({ file: 'main.ts', line: 1, severity: 'error', message: 'TypeScript: Type mismatch' });
  expect(copies[1]).toMatchObject({ file: 'main.ts', problems: [
    { line: 1, severity: 'error' }, { line: 2, severity: 'warning' },
  ] });
  await fileGroup.click({ button: 'right' });
  await fileProblemMenu.getByRole('menuitem', { name: 'Expand group' }).click();
  await problems.getByRole('button', { name: /Project lint warning/ }).click();
  await expect(page.locator('.statusbar')).toContainText('Ln 2, Col 1');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nserverS');
  await page.keyboard.press('Control+Space');
  await expect(page.getByRole('option', { name: 'serverSuggestion' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('F12');
  await expect(page.getByRole('tab', { name: 'helper.ts', exact: true })).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Ln 2, Col 8');
  await expect(problems).toContainText('No problems in this file.');
  await expect(problemsTab).toHaveText('Problems 0');
  await page.getByRole('button', { name: 'main.js', exact: true }).click();
  await expect(editor).toContainText('const value');
  expect((await calls()).opened).not.toContain('javascript');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\ndebugger;');
  await expect.poll(async () => (await calls()).linted).toContain('const value = 1;\ndebugger;');
  expect((await calls()).writes).toBe(0);
  await expect(problems).toContainText('main.js');
  await expect(problems).not.toContainText('TypeScript: Type mismatch');
  await expect(problemsTab).toHaveText('Problems 1');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'JavaScript', exact: true }).check();
  await page.getByRole('checkbox', { name: 'ESLint', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect.poll(async () => (await calls()).opened).toContain('javascript');
  await expect(problems).toContainText('No problems in this file.');
  await page.getByRole('tab', { name: 'main.ts', exact: true }).click();
  await expect(problems).toContainText('TypeScript: Type mismatch');
  await expect(problems).not.toContainText('Project lint warning (fixture)');
  await editor.click();
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('tab', { name: 'main.ts', exact: true }).locator('.dirty-dot')).toHaveCount(0);
  await page.getByRole('tab', { name: 'main.ts', exact: true }).locator('.flexlayout__tab_button_trailing').click();
  await expect(problems).not.toContainText('TypeScript: Type mismatch');
  await expect(problemsTab).toHaveText('Problems 0');
  await page.evaluate(() => { (window as any).languageCalls.failPython = true; });
  await page.getByRole('button', { name: 'view.py', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Python', exact: true }).check();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByText('Pyright was not found.')).toBeVisible();
  await editor.click();
  await page.keyboard.press('F12');
  await expect(page.getByText('Pyright was not found.')).toBeVisible();
  expect((await calls()).starts).toEqual(['typescript', 'python']);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'TypeScript', exact: true }).uncheck();
  expect((await calls()).stops).not.toContain('typescript');
  await page.getByRole('checkbox', { name: 'JavaScript', exact: true }).uncheck();
  await expect.poll(async () => (await calls()).stops).toContain('typescript');
});
