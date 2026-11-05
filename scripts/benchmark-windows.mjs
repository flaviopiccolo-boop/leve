import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const [, , executable, repetitions = '5'] = process.argv;
const runs = Number(repetitions);
assert(process.platform === 'win32' && executable && existsSync(executable) && Number.isInteger(runs) && runs > 0,
  'Usage: node scripts/benchmark-windows.mjs <Windows executable> [repetitions]');

function powershell(command) {
  const utf8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', utf8 + command], {
    encoding: 'utf8', windowsHide: true,
  }).trim();
}

assert(!powershell("Get-Process | Where-Object ProcessName -in 'leve','leve-editor' | Select-Object -ExpandProperty Id"),
  'Close Leve before running the benchmark.');
const recovery = join(powershell("[Environment]::GetFolderPath('LocalApplicationData')"), 'dev.leve.editor', 'recovery');
const output = resolve('artifacts');
mkdirSync(output, { recursive: true });
const runDirectory = mkdtempSync(join(output, 'windows-benchmark-'));
const backup = recovery + '.' + process.pid + '.benchmark-backup';
const profile = join(runDirectory, 'webview');
const marker = 'LEVE_BENCHMARK_MATCH';
const filename = 'benchmark-large.txt';
const largeText = 'Benchmark document line with printable ASCII data.\n'.repeat(60_000);
const fixtureText = 'Workspace benchmark sample line.\n'.repeat(248);

function createProject(files) {
  const root = join(runDirectory, 'project-' + files);
  for (let index = 0; index < files - 1; index++) {
    const folder = join(root, 'folder-' + String(Math.floor(index / 20)).padStart(3, '0'));
    if (index % 20 === 0) mkdirSync(folder, { recursive: true });
    const body = index === 0 ? marker + '\n' + fixtureText : fixtureText;
    writeFileSync(join(folder, 'source-' + index + '.txt'), body);
  }
  writeFileSync(join(root, filename), largeText);
  return root;
}

function memory(pid) {
  const readings = JSON.parse(powershell(`
    $ErrorActionPreference = 'Stop'
    $ids = @(${pid})
    $views = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'")
    do {
      $next = @($views | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids })
      $ids += @($next | ForEach-Object ProcessId)
    } while ($next.Count)
    $processes = @(Get-Process -Id $ids)
    @{ count = $processes.Count
       privateMiB = ($processes | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB
       workingSetMiB = ($processes | Measure-Object WorkingSet64 -Sum).Sum / 1MB } | ConvertTo-Json -Compress
  `));
  assert(readings.count > 1, 'No WebView2 descendants were counted.');
  return readings;
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function launch(action) {
  const port = await freePort();
  const endpoint = 'http://127.0.0.1:' + port;
  const start = performance.now();
  const app = spawn(resolve(executable), [], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
    stdio: 'ignore',
  });
  const exited = once(app, 'exit');
  try {
    for (;;) {
      assert(app.exitCode === null && performance.now() - start < 15_000, 'WebView2 did not become ready.');
      const response = await fetch(endpoint + '/json/list', { signal: AbortSignal.timeout(500) }).catch(() => null);
      if (response?.ok && (await response.json()).some(target => target.title.startsWith('Leve'))) break;
      await delay(20);
    }
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 5_000 });
    const [page] = browser.contexts()[0].pages();
    page.setDefaultTimeout(10_000);
    await page.locator('.statusbar').filter({ hasText: 'Local' }).waitFor();
    const startupMs = performance.now() - start;
    await action(page, app.pid, startupMs);
    await page.getByRole('button', { name: 'Close window' }).click({ noWaitAfter: true }).catch(error => {
      if (!page.isClosed()) throw error;
    });
    const [code] = await Promise.race([exited, delay(10_000, [null], { ref: false })]);
    assert.equal(code, 0, 'Leve did not close normally.');
    await browser.close();
  } finally {
    if (app.exitCode === null && app.signalCode === null) {
      app.kill();
      await exited;
    }
  }
}

async function time(action) {
  const start = performance.now();
  await action();
  return performance.now() - start;
}

function clearTestCheckpoint() {
  for (const file of ['session.json', 'session.previous.json']) {
    const path = join(recovery, file);
    if (existsSync(path)) unlinkSync(path);
  }
}

const projects = [100, 4_000].map(files => ({ files, root: createProject(files) }));
const samples = [];
if (existsSync(recovery)) {
  assert(!existsSync(backup), 'A benchmark backup already exists: ' + backup);
  renameSync(recovery, backup);
  console.log('Temporary recovery backup: ' + backup);
}
try {
  await launch(async page => {
    // Populate only the benchmark WebView profile. Project activation still goes through the UI.
    await page.evaluate(roots => localStorage.setItem('leve.projects.v1', JSON.stringify(roots)), projects.map(project => project.root));
  });
  for (let iteration = 1; iteration <= runs; iteration++) {
    for (const { files, root } of projects) {
      clearTestCheckpoint();
      writeFileSync(join(root, filename), largeText);
      await launch(async (page, pid, startupMs) => {
        await page.getByRole('button', { name: 'No folder open' }).waitFor();
        await delay(2_000);
        const idleMemory = memory(pid);
        await page.locator('.project-picker').click();
        const projectMs = await time(async () => {
          await page.getByRole('menuitem', { name: 'project-' + files, exact: false }).click();
          await page.getByRole('button', { name: filename, exact: true }).waitFor();
        });
        await page.keyboard.press('Control+p');
        const nameSearchMs = await time(async () => {
          await page.getByPlaceholder('File name or path').fill('source-' + (files - 2) + '.txt');
          await page.locator('.search-result').filter({ hasText: 'source-' + (files - 2) + '.txt' }).waitFor();
        });
        await page.keyboard.press('Control+Shift+f');
        let searchStatus;
        let searchLimit;
        const contentSearchMs = await time(async () => {
          await page.getByRole('textbox', { name: 'Search project contents' }).fill(marker);
          const status = page.locator('.content-search [role=status]').filter({ hasText: /searched file/ });
          await status.waitFor();
          searchStatus = await status.textContent();
          searchLimit = await page.locator('.content-search [role=alert]').allTextContents();
        });
        assert.match(searchStatus, /^1 match\(es\) in /);
        const editor = page.locator('.cm-content:visible');
        await page.getByTitle('Explorer', { exact: true }).click();
        const openMs = await time(async () => {
          await page.getByRole('button', { name: filename, exact: true }).click();
          await editor.getByText('Benchmark document line with printable ASCII data.', { exact: true }).first().waitFor();
        });
        await delay(2_000);
        const openMemory = memory(pid);
        await editor.focus();
        const editMs = await time(async () => {
          await page.keyboard.press('Control+Home');
          await page.keyboard.insertText('Saved by benchmark. ');
          await editor.getByText(/^Saved by benchmark/).waitFor();
        });
        const saveMs = await time(async () => {
          await page.keyboard.press('Control+s');
          await page.getByText(filename + ' saved.', { exact: true }).waitFor();
          assert(readFileSync(join(root, filename), 'utf8').startsWith('Saved by benchmark. '));
        });
        const sample = { iteration, files, startupMs, idleMemory, projectMs, nameSearchMs, contentSearchMs,
          searchStatus, searchLimit, openMs, openMemory, editMs, saveMs };
        samples.push(sample);
        console.log(JSON.stringify(sample));
        writeFileSync(join(runDirectory, 'results.json'), JSON.stringify(samples, null, 2) + '\n');
      });
    }
  }
  await launch(async page => {
    await page.locator('.project-picker').getByText('project-4000', { exact: true }).waitFor();
    await page.locator('.cm-content:visible').getByText(/^Saved by benchmark/).waitFor();
  });
  console.log('Saved file and open project restored after restart.');
} finally {
  if (existsSync(recovery)) renameSync(recovery, join(runDirectory, 'recovery'));
  if (existsSync(backup)) renameSync(backup, recovery);
  console.log(runDirectory);
}
