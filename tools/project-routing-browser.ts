// End-to-end project selection with deterministic providers; no model calls.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCollabServer } from '../packages/service/src/server.ts';
import { fixturePort } from '../packages/service/test/planning-fixture.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'collab-project-browser-')));
const project = join(root, 'Learning TypeScript');
mkdirSync(project);
writeFileSync(join(project, 'README.md'), '# Learning TypeScript\nCourse context.');
const evidence = resolve('artifacts/project-routing-2026-09-05');
mkdirSync(evidence, { recursive: true });
const destinations: string[] = [];
const options = {
  stateFile: join(root, 'events.sqlite'), uiDirectory: resolve('packages/ui/dist'),
  directoryPicker: async () => project,
  planning: { codexBinary: '/unused', portFactory: (_id: string, cwd: string) => { destinations.push(cwd); return fixturePort(); } },
};
let app = createCollabServer(options);
let address = await app.listen();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(address.launchUrl);
  const goal = page.getByLabel('What would you like help answering, deciding, or planning?');
  const folder = page.getByLabel('Project or workspace', { exact: true });
  await goal.fill('Review my TypeScript learning plan.');
  await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
  await expect(folder).toHaveValue(project);
  await expect(page.locator('#workspace-help')).toContainText('Use this folder for the collaboration and its provider sessions.');
  await expect(page.locator('#workspace-help')).toContainText('This does not automatically place sessions in the Codex or Claude desktop project sidebar.');
  await page.screenshot({ path: join(evidence, 'project-picker.png'), fullPage: true });
  await page.getByRole('button', { name: 'Start collaboration', exact: true }).click();
  await page.getByText('Ready for your consideration', { exact: true }).waitFor();
  await expect(page.getByLabel('Collaboration project')).toContainText('Learning TypeScript');
  await expect(page.getByLabel('Collaboration project').locator('[title]')).toHaveAttribute('title', project);
  await expect(page.locator('.run-item')).toContainText('Learning TypeScript');
  assert.deepEqual(destinations, [project]);
  assert.equal(app.store.projection(app.store.listRunIds()[0]!).goal?.projectContext, project);
  assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), '# Learning TypeScript\nCourse context.');

  // Reopening the app restores both the saved destination and recent choices.
  await app.close();
  app = createCollabServer(options);
  address = await app.listen();
  await page.goto(address.launchUrl);
  await expect(page.getByLabel('Collaboration project')).toContainText('Learning TypeScript');
  await page.getByRole('button', { name: 'New collaboration', exact: true }).click();
  const recent = page.getByLabel('Recent projects', { exact: true });
  await recent.selectOption(project);
  await expect(folder).toHaveValue(project);
  await goal.fill('Compare the next course options.');
  for (const width of [320, 390, 1360]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${width}px composer overflow: ${overflow}`);
    const axe = await new AxeBuilder({ page: page as any }).analyze();
    assert.deepEqual(axe.violations.filter(v => ['serious', 'critical'].includes(v.impact ?? '')), []);
  }
  await page.screenshot({ path: join(evidence, 'recent-project.png'), fullPage: true });
  await page.getByRole('button', { name: 'Start collaboration', exact: true }).click();
  await page.getByText('Ready for your consideration', { exact: true }).waitFor();
  assert.deepEqual(destinations, [project, project]);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
  await page.screenshot({ path: join(evidence, 'project-result-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const result = { passed: true, modelStarts: 0, folderPicker: true, recentProject: true, projectRetainedAfterRestart: true, bothRunsUseSelectedProject: true, sourceUnchanged: true, seriousCriticalViolations: 0 };
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`RESULT ${JSON.stringify(result)}`);
} finally { await browser.close(); await app.close(); }
