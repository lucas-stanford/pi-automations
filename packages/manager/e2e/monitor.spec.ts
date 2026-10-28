import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startMockServer } from './mock-server.mjs';

const shotsDir = join('test-results', 'am-shots');
let mock: Awaited<ReturnType<typeof startMockServer>>;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  mock = await startMockServer();
  await mkdir(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  if (mock) await new Promise<void>((resolve) => mock.server.close(() => resolve()));
});

test('monitor mode home, editor tabs, saves, files, raw mode and screenshots', async ({ page }) => {
  await page.goto(mock.url);
  await expect(page.getByRole('heading', { name: 'Automations', exact: true })).toBeVisible();
  await expect(page.getByText('flow-example')).toBeVisible();
  await page.screenshot({ path: join(shotsDir, 'home-dark.png'), fullPage: true });

  await page.getByRole('button', { name: /Theme/ }).click();
  await page.screenshot({ path: join(shotsDir, 'home-light.png'), fullPage: true });
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.getByRole('button', { name: /Theme/ }).click();

  await page.locator('.am-automation-row', { hasText: 'flow-example' }).click();
  await expect(page.getByRole('heading', { name: 'flow-example' })).toBeVisible();
  await page.screenshot({ path: join(shotsDir, 'flow-example-flow-dark.png'), fullPage: true });
  await page.getByRole('button', { name: /PRE HOOK pre0/ }).click();
  await page.screenshot({ path: join(shotsDir, 'flow-example-hook-selected-dark.png'), fullPage: true });
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.screenshot({ path: join(shotsDir, 'flow-example-flow-light.png'), fullPage: true });
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.getByRole('tab', { name: 'Source' }).click();
  await expect(page.getByRole('heading', { name: 'AUTOMATION.md' })).toBeVisible();
  await page.screenshot({ path: join(shotsDir, 'source-dark.png'), fullPage: true });

  await page.getByRole('tab', { name: 'Body' }).click();
  await page.getByRole('textbox', { name: 'Body' }).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Updated body from e2e.');
  await page.screenshot({ path: join(shotsDir, 'body-dark.png'), fullPage: true });
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.screenshot({ path: join(shotsDir, 'body-light.png'), fullPage: true });
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  await page.getByRole('tab', { name: 'Files' }).click();
  await page.getByRole('button', { name: /prepare.js/ }).click();
  await expect(page.getByRole('textbox', { name: 'prepare.js editor' })).toContainText('prepare');
  await page.screenshot({ path: join(shotsDir, 'files-dark.png'), fullPage: true });
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.screenshot({ path: join(shotsDir, 'files-light.png'), fullPage: true });
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.getByRole('button', { name: /Theme/ }).click();

  await page.getByRole('tab', { name: 'Runs' }).click();
  await expect(page.locator('p', { hasText: 'Completed flow-example' })).toBeVisible();
  // The run is drawn here, from what its record keeps: its chart, its steps and its notes.
  await expect(page.getByRole('img', { name: 'The run on its flowchart' })).toBeVisible();
  await expect(page.locator('.am-run-graph .am-run-node--done', { hasText: 'Draft outline' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Steps' })).toContainText('Status note ready');
  await expect(page.locator('.am-run-notes')).toContainText('Saved the status note for flow-example.');
  const noteLink = page.getByRole('link', { name: 'status note ↗' });
  await expect(noteLink).toHaveAttribute('href', 'https://example.com/notes/flow-example');
  await expect(noteLink).toHaveAttribute('target', '_blank');
  await expect(noteLink).toHaveAttribute('rel', 'noreferrer');
  await page.screenshot({ path: join(shotsDir, 'runs-dark.png'), fullPage: true });
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.screenshot({ path: join(shotsDir, 'runs-light.png'), fullPage: true });

  await page.getByRole('tab', { name: 'Body' }).click();
  await page.getByRole('textbox', { name: 'Body' }).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Conflict draft from e2e.');
  const automationPath = join(mock.dataDir, 'flow-example', 'AUTOMATION.md');
  await writeFile(automationPath, `${await readFile(automationPath, 'utf8')}\n<!-- external edit -->\n`, 'utf8');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Changed on disk since you opened it.')).toBeVisible();
  await page.screenshot({ path: join(shotsDir, 'conflict-banner-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review' }).first().click();
  await expect(page.getByRole('heading', { name: 'Review changes' })).toBeVisible();
  await page.screenshot({ path: join(shotsDir, 'diff-drawer-dark.png'), fullPage: true });

  await page.goto(mock.url);
  await page.locator('.am-automation-row', { hasText: 'daily-digest' }).click();
  await expect(page.getByRole('heading', { name: 'daily-digest' })).toBeVisible();
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.screenshot({ path: join(shotsDir, 'daily-digest-flow-dark.png'), fullPage: true });
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.screenshot({ path: join(shotsDir, 'daily-digest-flow-light.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Body' }).click();
  await page.getByLabel('Description').fill('Updated daily digest description.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  expect(existsSync(join(mock.dataDir, 'daily-digest', 'flow.mmd'))).toBe(false);
});

test('the Runs tab follows a running run, then shows a finished one', async ({ page }) => {
  await page.goto(mock.url);
  await page.locator('.am-automation-row', { hasText: 'issue-triage' }).click();
  await expect(page.getByRole('heading', { name: 'issue-triage' })).toBeVisible();
  await page.getByRole('tab', { name: 'Runs' }).click();
  await expect(page.locator('.am-run-notes')).toContainText('Commented on issue 12.');
  await expect(page.getByRole('link', { name: 'issue 12 ↗' })).toHaveAttribute('rel', 'noreferrer');
  await expect(page.getByRole('list', { name: 'Steps' })).toContainText('Reading the issue thread');
  await expect(page.locator('.am-run-graph .am-run-node--active')).toHaveCount(1);
  await expect(page.locator('.am-run-graph .am-run-node--active')).toContainText('Triage the issue');
  await page.screenshot({ path: join(shotsDir, 'runs-live-dark.png'), fullPage: true });

  await page.getByRole('button', { name: /ok\s*manual/ }).click();
  await expect(page.locator('.am-run-notes')).toContainText('Saved the status note for issue-triage.');
  await expect(page.locator('.am-run-graph .am-run-node--active')).toHaveCount(0);
});

test('History leads with each run\'s message and its links, and opens the run on its Runs tab', async ({ page }) => {
  await page.goto(mock.url);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'History' }).click();
  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
  const first = page.getByRole('list', { name: 'Runs' }).getByRole('listitem').filter({ hasText: 'Digest is up' });
  await expect(first.getByRole('link', { name: 'Canvas digest ↗' })).toHaveAttribute('href', 'https://example.com/digest/2026-10-22');
  await expect(first.getByRole('link', { name: 'PR #11911 ↗' })).toHaveAttribute('rel', 'noreferrer');
  await page.screenshot({ path: join(shotsDir, 'history-dark.png'), fullPage: true });
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.screenshot({ path: join(shotsDir, 'history-light.png'), fullPage: true });
  await page.getByRole('button', { name: /Theme/ }).click();
  await page.getByRole('button', { name: /Theme/ }).click();

  await page.getByRole('checkbox', { name: 'Only runs with a message or notes' }).check();
  await page.getByRole('combobox', { name: 'Outcome' }).selectOption('failed');
  await expect(page.getByText('No runs match.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Outcome' }).selectOption('');
  await expect(page).toHaveURL(/\/history\?message=1$/);

  await first.getByRole('link', { name: /daily-digest, ok, .*open the run/ }).click();
  await expect(page.getByRole('heading', { name: 'daily-digest' }).first()).toBeVisible();
  await expect(page).toHaveURL(/tab=runs/);
  const message = page.getByRole('region', { name: 'Message' });
  await expect(message).toContainText('2 PRs');
  await expect(message.getByRole('link', { name: 'PR #11920 ↗' })).toBeVisible();
  await page.screenshot({ path: join(shotsDir, 'runs-message-dark.png'), fullPage: true });
});

test('without a server the page says how to open the manager', async ({ page, baseURL }) => {
  await page.goto(baseURL ?? 'http://127.0.0.1:4173');
  await expect(page.getByRole('heading', { name: 'Automation Manager is not connected' })).toBeVisible();
  await expect(page.getByText('pa edit <name>')).toBeVisible();
});
