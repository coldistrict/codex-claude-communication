import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect } from "@playwright/test";
import { createCollabServer } from "../packages/service/src/server.ts";
import { fixturePort } from "../packages/service/test/planning-fixture.ts";
import { planningStages } from "../packages/ui/src/planning-view.tsx";

const root = mkdtempSync(join(tmpdir(), "collab-ui-regressions-"));
const evidence = resolve("artifacts/ui-review-2026-09-05");
mkdirSync(evidence, { recursive: true });
let clarify = false;
const app = createCollabServer({
  stateFile: join(root, "events.sqlite"),
  uiDirectory: resolve("packages/ui/dist"),
  planning: { codexBinary: "/unused", portFactory: () => fixturePort({ reject: true, clarify }) },
});
const address = await app.listen();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, reducedMotion: "reduce", colorScheme: "light" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(address.launchUrl);
  const goal = page.getByLabel("What would you like help answering, deciding, or planning?");
  await page.getByRole("button", { name: "Make a plan", exact: true }).click();
  await expect(goal).toHaveValue("Help me turn this goal into a practical plan: ");
  await expect(goal).toBeFocused();
  await goal.fill("Create the first review fixture.");
  await page.screenshot({ path: join(evidence, "composer-desktop.png"), fullPage: true });
  await goal.press("Control+Enter");
  await page.getByText("Ready for your consideration", { exact: true }).waitFor();
  const firstId = app.store.listRunIds()[0]!;

  // A completed run must not lend its readiness or approval to an old draft.
  await page.getByLabel("Document revision").selectOption("1");
  await expect(page.locator(".planning-status")).toContainText("Earlier revision");
  await expect(page.locator(".planning-status")).toContainText("Revision requested");
  await expect(page.locator(".planning-status")).not.toContainText("Both approved");
  await expect(page.locator(".planning-status")).not.toContainText("Ready for your consideration");
  await expect(page.getByRole("button", { name: "Export latest Markdown", exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, "historical-revision.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to latest", exact: true }).click();
  await expect(page.getByLabel("Document revision")).toHaveValue("2");
  await expect(page.locator(".planning-status")).toContainText("Both approved");
  await expect(page.locator(".timeline-history")).not.toHaveAttribute("open");

  // Closing with Escape keeps all draft fields and expanded context controls.
  const newButton = page.getByRole("button", { name: "New collaboration", exact: true });
  await newButton.click();
  const dialog = page.getByRole("dialog");
  await expect(goal).toBeFocused();
  await goal.fill("Keep this draft while I inspect the current answer.");
  await page.getByText("Context and limits", { exact: true }).click();
  const conditions = page.getByLabel("Required conditions (optional, one per line)");
  await conditions.fill("Preserve this requirement.");
  await goal.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(newButton).toBeFocused();
  await newButton.click();
  await expect(goal).toBeFocused();
  await expect(goal).toHaveValue("Keep this draft while I inspect the current answer.");
  await expect(conditions).toHaveValue("Preserve this requirement.");
  await expect(conditions).toBeVisible();

  // Real server validation is visible and focusable inside the modal.
  await page.getByLabel("Project or workspace", { exact: true }).fill("/missing-ui-review-folder");
  await page.getByRole("button", { name: "Start collaboration", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("could not be found");
  await expect(dialog.getByRole("alert")).toBeFocused();
  assert.equal(app.store.listRunIds().length, 1);
  await page.screenshot({ path: join(evidence, "recoverable-error.png"), fullPage: true });

  // A failed connection retains the draft, and shortcuts cannot double-submit.
  await page.getByLabel("Project or workspace", { exact: true }).fill("");
  await conditions.fill("");
  let posts = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    await held;
    await route.abort("connectionfailed");
  });
  await page.getByRole("button", { name: "Start collaboration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Starting…", exact: true })).toBeDisabled();
  await goal.press("Control+Enter");
  assert.equal(posts, 1);
  release();
  await expect(dialog.getByRole("alert")).toContainText("connection was interrupted");
  await expect(goal).toHaveValue("Keep this draft while I inspect the current answer.");
  await expect(page.getByRole("button", { name: "Start collaboration", exact: true })).toBeEnabled();
  await page.unroute("**/api/runs");
  await page.getByRole("button", { name: "Start collaboration", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByText("Ready for your consideration", { exact: true }).waitFor();
  assert.equal(app.store.listRunIds().length, 2);
  await expect(page.locator("#run-goal-heading")).toBeFocused();
  const order = await page.locator(".run-item-goal").allTextContents();
  app.publish(firstId);
  await expect(page.locator(".run-item-goal")).toHaveText(order);
  await page.getByRole("button", { name: "Skip to content", exact: true }).focus();
  await page.getByRole("button", { name: "Skip to content", exact: true }).press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  assert.equal(new URL(page.url()).hash, "", "In-page navigation must not replace the single-use launch fragment");

  // Terminal and paused stages must never retain a working spinner.
  clarify = true;
  // Deliver the create response only after the newer SSE projection is visible.
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await expect(page.locator(".run-item").first()).toContainText("Needs your input");
    await route.fulfill({ response });
  });
  await newButton.click();
  await expect(goal).toHaveValue("");
  await goal.fill("Cancel this fixture before it produces a document.");
  await page.getByRole("button", { name: "Start collaboration", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#run-goal-heading")).toHaveText("Cancel this fixture before it produces a document.");
  await page.getByRole("heading", { name: "A decision needs your input" }).waitFor();
  await page.unroute("**/api/runs");
  await expect(page.locator(".document-pending .skeleton")).toHaveCount(0);
  const paused = app.store.projection(app.store.listRunIds()[0]!);
  paused.workers.codex.state = "working";
  paused.workers.codex.activity = "proposal";
  paused.planning!.steps.push({ ...paused.planning!.steps[0]!, key: "0|proposal:claude", phase: "proposal" });
  const progress = planningStages(paused);
  assert.equal(progress.stages[0]!.status, "partial");
  assert.equal(progress.now, null);
  await page.locator(".run-header").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: "No completed document" }).waitFor();
  await expect(page.locator(".document-pending")).toContainText("ended before a document was produced");
  await expect(page.locator(".planning-status")).toContainText("No document produced");
  await expect(page.locator(".planning-status")).not.toContainText("Pending");
  await expect(page.locator(".document-pending .skeleton")).toHaveCount(0);
  await page.getByText("Workflow history", { exact: true }).click();
  await expect(page.locator(".timeline .spinner")).toHaveCount(0);

  // Exercise the mobile history disclosure and verify selection collapses it.
  await page.setViewportSize({ width: 390, height: 844 });
  const history = page.getByRole("button", { name: /^Collaborations \d+$/ });
  await expect(history).toHaveAttribute("aria-expanded", "false");
  await history.click();
  await page.getByRole("button", { name: /Create the first review fixture\./ }).click();
  await expect(history).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#run-goal-heading")).toHaveText("Create the first review fixture.");

  let maxOverflow = 0;
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const scheme of ["light", "dark"] as const) {
      await page.getByTitle(`${scheme === "light" ? "Light" : "Dark"} theme`, { exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      maxOverflow = Math.max(maxOverflow, overflow);
      assert.ok(overflow <= 1, `${width}px ${scheme} overflow: ${overflow}`);
      // axe's bundled Playwright types differ from the pinned browser runtime.
      const axe = await new AxeBuilder({ page: page as any }).analyze();
      assert.deepEqual(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")), []);
      await page.screenshot({ path: join(evidence, `result-${width}-${scheme}.png`), fullPage: true });
    }
  }
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  assert.deepEqual(errors, []);
  const result = { passed: true, modelStarts: 0, historicalStatus: true, draftPreserved: true, recoverableErrors: true, duplicateSubmissionPrevented: true, staleReplyPreservesLiveProgress: true, stableHistory: true, stoppedProgress: true, keyboardFocus: true, mobileHistory: true, seriousCriticalViolations: 0, maxOverflowPx: maxOverflow };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`RESULT ${JSON.stringify(result)}`);
} catch (error) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  for (const page of pages) {
    await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true });
    console.error((await page.locator("body").innerText()).slice(0, 6000));
  }
  console.error(app.store.listRunIds().map((id) => {
    const run = app.store.projection(id);
    return { goal: run.goal?.goal, state: run.state, actions: run.actions.map((action) => action.title) };
  }));
  throw error;
} finally {
  await browser.close();
  await app.close();
}
