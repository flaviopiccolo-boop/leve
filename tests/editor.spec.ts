import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => {
  // Keep the browser's unsaved-changes prompt out of test teardown.
  await page.keyboard.press('Control+s');
});

test('starts with the explorer on the left and terminals below the editor', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Espaço para criar.' })).toBeVisible();
  await expect(page.getByText('Prévia web · nenhum comando é executado aqui')).toBeVisible();
  const tree = await page.locator('.explorer').boundingBox();
  const editor = await page.locator('.welcome').boundingBox();
  const terminal = await page.locator('.terminal-start').boundingBox();
  expect(tree!.x).toBeLessThan(editor!.x);
  expect(terminal!.y).toBeGreaterThan(editor!.y);
  expect(terminal!.x).toBe(editor!.x);
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
  await page.keyboard.insertText('\n# arquivo editado');
  await expect(page.getByRole('tab', { name: 'main.py', exact: true }).locator('.dirty-dot')).toHaveCount(1);
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('tab', { name: 'main.py', exact: true }).locator('.dirty-dot')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('salvo apenas na demonstração');
  const tab = page.getByRole('tab', { name: 'main.py', exact: true });
  await tab.locator('.flexlayout__tab_button_trailing').click();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('# arquivo editado');
  await page.getByRole('button', { name: 'Fechar aviso' }).click();
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
  await page.keyboard.insertText('\n# não perder');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('tab', { name: 'main.py', exact: true }).locator('.flexlayout__tab_button_trailing').click();
  await expect(page.locator('.cm-content')).toContainText('# não perder');
  await expect(page.getByRole('tab', { name: 'main.py', exact: true }).locator('.dirty-dot')).toHaveCount(1);
});

test('moves the explorer to the right and restores the saved layout on reload', async ({ page }) => {
  await page.goto('/');
  const tab = await page.locator('.flexlayout__tab_button').filter({ hasText: 'Explorador' }).boundingBox();
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
