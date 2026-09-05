import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { createCollabServer } from "@collab/service";

const here = dirname(fileURLToPath(import.meta.url));
const uiDirectory = resolve(here, "../dist");
const directory = mkdtempSync(join(tmpdir(), "collab-ui-a11y-"));
const legacyRoot = join(directory, "legacy-tasks");
const legacyTaskRoot = join(legacyRoot, "legacy-escaped-fixture");
mkdirSync(legacyTaskRoot, { recursive: true, mode: 0o700 });
writeFileSync(
  join(legacyTaskRoot, "TASK.md"),
  "Objective: Render <script data-fixture>bad()</script> as text\n",
  { mode: 0o600 },
);
writeFileSync(
  join(legacyTaskRoot, "codex-notes.md"),
  "<img data-fixture src=x onerror=bad()>\n",
  { mode: 0o600 },
);
writeFileSync(
  join(legacyTaskRoot, "state.json"),
  '{"status":"completed"}\n',
  { mode: 0o600 },
);
const attachmentPath = join(directory, "ui-attachment.txt");
writeFileSync(attachmentPath, "UI attachment fixture\n", { mode: 0o600 });
let app = createCollabServer({
  stateFile: join(directory, "events.sqlite"),
  uiDirectory,
  legacyTasksRoot: legacyRoot,
  directoryPicker: async () => directory,
});
let address = await app.listen();
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(address.launchUrl.replace("/#", "/?adapter=fake#"));
  await page.getByRole("heading", { name: "New collaboration" }).waitFor();
  await page.getByRole("heading", { name: "Legacy task folders" }).waitFor();
  await page
    .getByRole("button", { name: /legacy-escaped-fixture/i })
    .click();
  await page.getByRole("heading", { name: "legacy-escaped-fixture" }).waitFor();
  if ((await page.locator("script[data-fixture]").count()) !== 0) {
    throw new Error("LEGACY_SCRIPT_RENDERED_AS_ACTIVE_CONTENT");
  }
  if ((await page.locator("img[data-fixture]").count()) !== 0) {
    throw new Error("LEGACY_IMAGE_RENDERED_AS_ACTIVE_CONTENT");
  }
  await page
    .locator(".legacy-detail")
    .getByText("<script data-fixture>bad()</script>", { exact: false })
    .waitFor();
  const cleanedUrl = page.url();
  if (cleanedUrl.includes("#")) throw new Error("CAPABILITY_FRAGMENT_NOT_REMOVED");

  const initialAxe = await new AxeBuilder({ page: page as any }).analyze();
  const seriousInitial = initialAxe.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
  if (seriousInitial.length) {
    throw new Error(
      `A11Y_INITIAL:${seriousInitial
        .map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            summary: node.failureSummary,
          })),
        }))
        .map((violation) => JSON.stringify(violation))
        .join(",")}`,
    );
  }

  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.waitForFunction(
    (expected) =>
      (document.querySelector('input[name="workspace"]') as HTMLInputElement | null)
        ?.value === expected,
    realpathSync(directory),
  );
  await page
    .getByLabel("What should Codex and Claude accomplish together?")
    .fill("Create one accessible deterministic collaboration fixture.");
  await page.getByText("Advanced settings").click();
  await page.getByLabel("Permission preset").selectOption("read_only");
  await page.getByLabel("Resource mode").selectOption("serialized");
  await page.getByLabel("Stop after provider work (minutes, optional)").fill("7");
  await page
    .getByLabel("Attachments (one workspace-contained path per line)")
    .fill(attachmentPath);
  const started = performance.now();
  await page.getByRole("button", { name: "Start collaboration" }).press("Enter");
  await page
    .getByRole("heading", { name: "Create one accessible deterministic collaboration fixture." })
    .waitFor();
  await page.getByText("Demo billing — not a proven route").first().waitFor();
  await page.getByText("Run details", { exact: true }).click();
  await page.getByText("Sandbox: read-only").waitFor();
  await page.getByText("Resources: serialized").waitFor();
  await page.getByText("Stop: 7 min").waitFor();
  await page.getByText("Attachments (1 immutable references)").waitFor();
  const renderLatencyMs = performance.now() - started;

  const runAxe = await new AxeBuilder({ page: page as any }).analyze();
  const seriousRun = runAxe.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
  if (seriousRun.length) {
    throw new Error(
      `A11Y_RUN:${seriousRun
        .map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            summary: node.failureSummary,
          })),
        }))
        .map((violation) => JSON.stringify(violation))
        .join(",")}`,
    );
  }
  const liveRegions = await page.locator("[aria-live]").count();
  if (liveRegions !== 1) throw new Error(`LIVE_REGION_ALLOWLIST:${liveRegions}`);

  await page.getByRole("button", { name: "Create run" }).click();
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 1) throw new Error(`REFLOW_OVERFLOW:${overflow}`);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });

  await page.getByLabel("Project or workspace").focus();
  await page.keyboard.press("Tab");
  const focusState = await page.evaluate(() => {
    const active = document.activeElement;
    const style = active ? getComputedStyle(active) : null;
    return {
      tag: active?.tagName ?? null,
      text: active?.textContent ?? null,
      name: active?.getAttribute("name") ?? null,
      outlineStyle: style?.outlineStyle ?? null,
      outlineWidth: style?.outlineWidth ?? null,
      focusRule: [...document.styleSheets].some((sheet) =>
        [...sheet.cssRules].some(
          (rule) =>
            rule instanceof CSSStyleRule &&
            rule.selectorText === ":focus" &&
            rule.style.outline.includes("3px"),
        ),
      ),
    };
  });
  if (
    focusState.tag !== "BUTTON" ||
    focusState.text?.trim() !== "Choose folder…" ||
    focusState.focusRule !== true
  ) {
    throw new Error(`KEYBOARD_FOCUS_MISSING:${JSON.stringify(focusState)}`);
  }
  await page.keyboard.press("Tab");
  if (
    (await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      name: document.activeElement?.getAttribute("name") ?? null,
    }))).name !== "goal"
  ) {
    throw new Error("KEYBOARD_FOCUS_DID_NOT_REACH_GOAL");
  }

  const sequence = await page
    .locator(".packet-list li")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent));
  if (sequence.length !== 2) throw new Error(`SSE_SEQUENCE_COUNT:${sequence.length}`);
  if (new Set(sequence).size !== sequence.length) throw new Error("SSE_DUPLICATE_RENDER");

  await page
    .getByLabel("What should Codex and Claude accomplish together?")
    .fill("Create a second persisted collaboration fixture.");
  await page.getByRole("button", { name: "Start collaboration" }).click();
  await page
    .getByRole("heading", {
      name: "Create a second persisted collaboration fixture.",
    })
    .waitFor();
  await page.locator(".run-item").nth(1).waitFor();
  const renderedRunCount = await page.locator(".run-item").count();
  if (renderedRunCount !== 2) {
    const renderedRuns = await page.locator(".run-item").evaluateAll((nodes) =>
      nodes.map((node) => ({
        tag: node.tagName,
        className: node.className,
        text: node.textContent,
      })),
    );
    throw new Error(
      `MULTI_RUN_HISTORY_NOT_RENDERED:${renderedRunCount}:${JSON.stringify(renderedRuns)}`,
    );
  }
  const actionRunId = app.coordinator.createRun(
    {
      goal: "Persist an action-needed collaboration across restart.",
      workspace: directory,
      mode: "fake",
    },
    true,
  );
  app.store.append({
    runId: actionRunId,
    actor: "system",
    type: "needs_input",
    idempotencyKey: "a11y:persisted-action",
    payload: {
      card: {
        id: "a11y_persisted_action",
        kind: "needs_input",
        title: "Persisted action survives restart",
        body: "This fixture verifies action-card restoration.",
        actions: ["Cancel"],
      },
    },
  });

  const restartPort = address.port;
  await app.close();
  app = createCollabServer({
    stateFile: join(directory, "events.sqlite"),
    uiDirectory,
    legacyTasksRoot: legacyRoot,
    directoryPicker: async () => directory,
  });
  address = await app.listen(restartPort);
  await page.reload();
  await page
    .getByRole("heading", {
      name: "Persist an action-needed collaboration across restart.",
    })
    .waitFor();
  await page.getByText("Persisted action survives restart").waitFor();
  if ((await page.locator(".run-item").count()) !== 3) {
    throw new Error("MULTI_RUN_HISTORY_NOT_RESTORED");
  }
  await page
    .getByRole("button", {
      name: /Create one accessible deterministic collaboration fixture\./,
    })
    .click();
  const afterRestartSequence = await page
    .locator(".packet-list li")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent));
  if (afterRestartSequence.length !== 2) {
    throw new Error(`RESTART_SEQUENCE_COUNT:${afterRestartSequence.length}`);
  }
  if (new Set(afterRestartSequence).size !== afterRestartSequence.length) {
    throw new Error("RESTART_DUPLICATE_RENDER");
  }

  // Adviser lane: hidden while every run has the adviser disabled; visible
  // with the Ask button, worker-loop overhead copy, and no extra live region
  // on an adviser-enabled run. The button is asserted and keyboard-focused
  // but never clicked here: a click would enqueue a wake and the V-11
  // harness must stay free of provider metadata work.
  if ((await page.locator(".advisor-lane").count()) !== 0) {
    throw new Error("ADVISOR_LANE_VISIBLE_WHILE_DISABLED");
  }
  await page.getByRole("button", { name: "Create run" }).click();
  await page.getByLabel("Project or workspace").fill(directory);
  await page
    .getByLabel("What should Codex and Claude accomplish together?")
    .fill("Create an adviser-enabled collaboration fixture.");
  await page.getByText("Advanced settings").click();
  await page
    .getByText("Enable the advisory supervisor", { exact: false })
    .click();
  await page.getByLabel("Adviser provider").selectOption("claude");
  await page.getByLabel("Adviser effort").selectOption("high");
  await page.getByRole("button", { name: "Start collaboration" }).click();
  await page
    .getByRole("heading", {
      name: "Create an adviser-enabled collaboration fixture.",
    })
    .waitFor();
  await page.getByRole("heading", { name: "Adviser", exact: true }).waitFor();
  await page.getByText("advisory supervisor · zero authority").waitFor();
  const askButton = page.getByRole("button", { name: "Ask the adviser" });
  await askButton.waitFor();
  await askButton.focus();
  const askFocused = await page.evaluate(
    () => document.activeElement?.textContent === "Ask the adviser",
  );
  if (!askFocused) throw new Error("ADVISOR_ASK_BUTTON_NOT_FOCUSABLE");
  const advisorLiveRegions = await page.locator("[aria-live]").count();
  if (advisorLiveRegions !== 1) {
    throw new Error(`ADVISOR_LIVE_REGION_ALLOWLIST:${advisorLiveRegions}`);
  }
  const advisorAxe = await new AxeBuilder({ page: page as any }).analyze();
  const seriousAdvisor = advisorAxe.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
  if (seriousAdvisor.length) {
    throw new Error(
      `A11Y_ADVISOR:${seriousAdvisor.map((violation) => violation.id).join(",")}`,
    );
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  const advisorOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (advisorOverflow > 1) throw new Error(`ADVISOR_REFLOW_OVERFLOW:${advisorOverflow}`);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });

  // Adviser sidecar writes do not advance the core event sequence. Simulate
  // the publish performed after a terminal adviser wake and verify that the
  // selected run refetches its adviser view without navigation or polling.
  const advisorRunId = app.store
    .listRunIds()
    .find(
      (runId) =>
        app.store.projection(runId).goal?.goal ===
        "Create an adviser-enabled collaboration fixture.",
    );
  if (!advisorRunId) throw new Error("ADVISOR_REFRESH_RUN_NOT_FOUND");
  const advisorCoreSeq = app.store.projection(advisorRunId).seq;
  app.advisorService.sidecar.append(
    advisorRunId,
    "observation",
    "wake_ui_refresh",
    {
      trigger: { kind: "terminal_retrospective" },
      output: {
        observations: [
          {
            severity: "info",
            summary: "Terminal adviser sidecar refreshed without navigation.",
            eventIds: ["evt_ui_refresh"],
            recommendationCode: null,
          },
        ],
        notes: "UI refresh fixture.",
      },
    },
  );
  app.publish(advisorRunId);
  await page
    .getByText("Terminal adviser sidecar refreshed without navigation.", {
      exact: false,
    })
    .waitFor();
  if (app.store.projection(advisorRunId).seq !== advisorCoreSeq) {
    throw new Error("ADVISOR_REFRESH_ADVANCED_CORE_SEQUENCE");
  }

  // Defect D-1 regression: the "Wakes used" counter must mirror
  // AdvisorService.consumedWakeUnits — wake_outcome rows with a guarded model
  // start and the reactive purpose — never advisorUsage.wakeCount, which
  // counts every claimed wake. Fabricate the conflating ledger: one consumed
  // reactive wake, one consumed reserved retrospective, and one
  // preflight-blocked wake that consumed nothing. Three wakes are claimed but
  // only one reactive unit is spent, so a counter derived from claims (or
  // from every guarded model start) renders 3 (or 2) of 2 and fails the
  // final wait below.
  await page.getByText("Wakes used: 0 of 2 reactive", { exact: false }).waitFor();
  const wakeFixtures = [
    {
      wakeId: "wake_d1_reactive",
      purpose: "advisor_observation",
      outcome: "completed",
      modelStarted: true,
    },
    {
      wakeId: "wake_d1_retrospective",
      purpose: "advisor_retrospective",
      outcome: "completed",
      modelStarted: true,
    },
    {
      wakeId: "wake_d1_blocked",
      purpose: "advisor_observation",
      outcome: "preflight_blocked",
      modelStarted: false,
    },
  ];
  for (const fixture of wakeFixtures) {
    app.advisorService.sidecar.append(
      advisorRunId,
      "wake_claimed",
      fixture.wakeId,
      {
        provider: "claude",
        effort: "high",
        readyWorkId: `ready_${fixture.wakeId}`,
        triggerEventId: "evt_ui_refresh",
        triggerKind:
          fixture.purpose === "advisor_retrospective"
            ? "terminal_retrospective"
            : "user_request",
        conditionInstanceId: `fixture:${fixture.wakeId}`,
        purpose: fixture.purpose,
        wakeReason: "d1-regression-fixture",
        sinceSeq: 0,
      },
    );
    app.advisorService.sidecar.append(
      advisorRunId,
      "wake_outcome",
      fixture.wakeId,
      {
        outcome: fixture.outcome,
        modelStarted: fixture.modelStarted,
        purpose: fixture.purpose,
      },
    );
  }
  app.publish(advisorRunId);
  await page
    .getByText("Wakes used: 1 of 2 reactive + 1 reserved retrospective", {
      exact: false,
    })
    .waitFor();

  await page.emulateMedia({ colorScheme: "dark" });
  const darkAxe = await new AxeBuilder({ page: page as any }).analyze();
  const seriousDark = darkAxe.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
  if (seriousDark.length) {
    throw new Error(
      `A11Y_DARK:${seriousDark
        .map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            summary: node.failureSummary,
          })),
        }))
        .map((violation) => JSON.stringify(violation))
        .join(",")}`,
    );
  }

  process.stdout.write(
    `RESULT ${JSON.stringify({
      suite: "V-11",
      passed: true,
      seriousCriticalViolations: 0,
      seriousCriticalDarkViolations: 0,
      keyboardComplete: true,
      liveRegions,
      reflowOverflowPx: overflow,
      eventRenderMs: Number(renderLatencyMs.toFixed(2)),
      sseDuplicates: 0,
      restartRestored: true,
      multiRunHistoryRestored: true,
      actionCardRestored: true,
      legacyBrowserEscaped: true,
      advancedControlsPersisted: true,
      advisorLaneCovered: true,
      advisorSameSequenceRefresh: true,
      advisorWakeCounterConsumedUnitsOnly: true,
      modelStarts: 0,
    })}\n`,
  );
} finally {
  await browser.close();
  await app.close();
}
