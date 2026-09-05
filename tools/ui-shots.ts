import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createCollabServer } from "@collab/service";

const here = dirname(fileURLToPath(import.meta.url));
const uiDirectory = resolve(here, "../packages/ui/dist");
const outDir = resolve(here, "../artifacts/ui");
mkdirSync(outDir, { recursive: true });

const directory = mkdtempSync(join(tmpdir(), "collab-ui-shots-"));
const legacyRoot = join(directory, "legacy-tasks");
const legacyTaskRoot = join(legacyRoot, "sample-legacy-task");
mkdirSync(legacyTaskRoot, { recursive: true, mode: 0o700 });
writeFileSync(join(legacyTaskRoot, "TASK.md"), "Objective: sample\n", { mode: 0o600 });
writeFileSync(join(legacyTaskRoot, "state.json"), '{"status":"completed"}\n', { mode: 0o600 });

const app = createCollabServer({
  stateFile: join(directory, "events.sqlite"),
  uiDirectory,
  legacyTasksRoot: legacyRoot,
  directoryPicker: async () => directory,
});
const address = await app.listen();
const browser = await chromium.launch({ headless: true });

const shots: string[] = [];
const VIEWPORTS: Array<readonly [string, number]> = [
  ["wide", 1280],
  ["mid", 900],
  ["narrow", 640],
];

try {
  // One context only: the launch capability is single-use by design.
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(address.launchUrl.replace("/#", "/?adapter=fake#"));
  await page.getByRole("heading", { name: "New collaboration" }).waitFor();

  async function capture(stage: string) {
    for (const [label, width] of VIEWPORTS) {
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForTimeout(200);
        const file = join(outDir, `${stage}-${label}-${scheme}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(file);
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 1000 });
  }

  await capture("1-idle");

  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page
    .getByLabel("What should Codex and Claude accomplish together?")
    .fill("Improve the collaboration dashboard visual design.");
  await page.getByRole("button", { name: "Start collaboration" }).click();
  await page
    .getByRole("heading", {
      name: "Improve the collaboration dashboard visual design.",
    })
    .waitFor();
  await page.waitForTimeout(2500);

  await capture("2-active-run");

  // Narrow-viewport creation path is NOT covered by V-11; exercise it here.
  await page.setViewportSize({ width: 640, height: 1000 });
  await page.getByRole("button", { name: "Create run" }).click();
  await page.getByRole("heading", { name: "New collaboration" }).waitFor();
  const narrowCreate = join(outDir, "3-narrow-create-reopened.png");
  await page.screenshot({ path: narrowCreate, fullPage: true });
  shots.push(narrowCreate);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );

  process.stdout.write(
    `SHOTS ${JSON.stringify({ narrowCreateOverflowPx: overflow, files: shots }, null, 2)}\n`,
  );
} finally {
  await browser.close();
  await app.close();
}
