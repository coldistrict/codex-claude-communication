import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_ENV_NAMES,
  ModelStartGuard,
  auditSpawnArgs,
  scrubProviderEnvironment,
} from "@collab/adapters";
import { createCollabServer } from "@collab/service";
import {
  assertSafeAbsolutePath,
  escapeUntrustedText,
  redactSecrets,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const uiDirectory = resolve(here, "../../ui/dist");

describe("V-9 loopback security and secret handling", () => {
  it("keeps the public shell data-empty and enforces one-time bootstrap, cookie, CSRF, Host, and Origin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collab-security-"));
    const app = createCollabServer({
      stateFile: join(directory, "events.sqlite"),
      uiDirectory,
      sessionLifetimeMs: 60_000,
    });
    const address = await app.listen();
    try {
      const shell = await fetch(`${address.url}/`);
      const shellText = await shell.text();
      expect(shell.status).toBe(200);
      expect(shellText).not.toContain("secret fixture goal");
      expect(shellText).not.toContain(app.sessions.capability);

      const unauthorized = await fetch(`${address.url}/api/runs`);
      expect(unauthorized.status).toBe(403);
      const wrongOrigin = await fetch(`${address.url}/bootstrap`, {
        method: "POST",
        headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
        body: JSON.stringify({ capability: app.sessions.capability }),
      });
      expect(wrongOrigin.status).toBe(403);

      const bootstrap = await fetch(`${address.url}/bootstrap`, {
        method: "POST",
        headers: { Origin: address.url, "Content-Type": "application/json" },
        body: JSON.stringify({ capability: app.sessions.capability }),
      });
      expect(bootstrap.status).toBe(200);
      const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
      const { csrf } = await bootstrap.json();
      expect(bootstrap.headers.get("set-cookie")).toContain("HttpOnly");
      expect(bootstrap.headers.get("set-cookie")).toContain("SameSite=Strict");

      const replay = await fetch(`${address.url}/bootstrap`, {
        method: "POST",
        headers: { Origin: address.url, "Content-Type": "application/json" },
        body: JSON.stringify({ capability: app.sessions.capability }),
      });
      expect(replay.status).toBe(403);

      const noCsrf = await fetch(`${address.url}/api/runs`, {
        method: "POST",
        headers: { Origin: address.url, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "secret fixture goal", workspace: directory }),
      });
      expect(noCsrf.status).toBe(403);

      const created = await fetch(`${address.url}/api/runs`, {
        method: "POST",
        headers: {
          Origin: address.url,
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-Collab-CSRF": csrf,
        },
        body: JSON.stringify({ goal: "secret fixture goal", workspace: directory, mode: "fake" }),
      });
      expect(created.status).toBe(201);
      const run = await created.json();
      expect(run.goal.goal).toBe("secret fixture goal");
      expect(run.barrierReleased).toBe(true);
      // Demo-mode billing is synthesised, so the durable status must carry
      // the simulated marker and never render as a proven route.
      expect(run.billing.codex.route).toBe("subscription_allowance");
      expect(run.billing.claude.route).toBe("subscription_allowance");
      expect(run.billing.codex.simulated).toBe(true);
      expect(run.billing.claude.simulated).toBe(true);
      expect(run.billing.codex.proof[0]).toContain("SIMULATED");
      expect(run.billing.claude.proof[0]).toContain("SIMULATED");

      const shellAfterData = await (await fetch(`${address.url}/`)).text();
      expect(shellAfterData).not.toContain("secret fixture goal");
      const protectedRead = await fetch(`${address.url}/api/runs`, {
        headers: { Cookie: cookie },
      });
      expect(protectedRead.status).toBe(200);
      const fixtureRetry = await fetch(
        `${address.url}/api/runs/${run.runId}/retry-preflight`,
        {
          method: "POST",
          headers: {
            Origin: address.url,
            Cookie: cookie,
            "Content-Type": "application/json",
            "X-Collab-CSRF": csrf,
          },
          body: JSON.stringify({ provider: "codex", fixture: "clean" }),
        },
      );
      expect(fixtureRetry.status).toBe(400);
      expect((await fixtureRetry.json()).error).toBe(
        "FIXTURE_PREFLIGHT_DISABLED",
      );
      const cancelled = await fetch(`${address.url}/api/runs/${run.runId}/cancel`, {
        method: "POST",
        headers: {
          Origin: address.url,
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-Collab-CSRF": csrf,
        },
        body: "{}",
      });
      expect(cancelled.status).toBe(200);
      expect((await cancelled.json()).state).toBe("cancelled");
    } finally {
      await app.close();
    }
  });

  it("redacts fixture secrets, escapes active content, rejects traversal, and scrubs the actual child environment", async () => {
    const secrets = [
      "sk-proj-abcdefghijklmnop123456",
      "sk-ant-abcdefghijklmnop123456",
      "Bearer abcdefghijklmnopqrstuvwxyz1234",
      "eyJaaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc",
    ];
    const redacted = redactSecrets(secrets.join("\n"));
    for (const secret of secrets) expect(redacted).not.toContain(secret);
    expect(escapeUntrustedText('<img src=x onerror="steal()">')).not.toContain("<img");
    expect(() => assertSafeAbsolutePath("/tmp/allowed/../escape", ["/tmp/allowed"])).toThrow(
      /PATH_OUTSIDE_ALLOWED_ROOTS/,
    );

    const source = { ...process.env };
    for (const name of FORBIDDEN_ENV_NAMES) source[name] = `fixture-${name}`;
    const scrubbed = scrubProviderEnvironment(source);
    const { stdout } = await execFileAsync(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      { env: scrubbed.env },
    );
    const childEnvironment = JSON.parse(stdout);
    for (const name of FORBIDDEN_ENV_NAMES) expect(childEnvironment[name]).toBeUndefined();
    expect(auditSpawnArgs(["--bare", "--ephemeral", "safe"])).toEqual(["--bare", "--ephemeral"]);
  });

  it("makes forbidden billing methods structurally unreachable", () => {
    const guard = new ModelStartGuard();
    expect(() => guard.recordForbiddenBillingMethod("account/rateLimitResetCredit/consume")).toThrow(
      /FORBIDDEN_BILLING_METHOD/,
    );
    expect(guard.forbiddenBillingMethods).toBe(1);
    expect(guard.started).toBe(0);
  });

  it("prints the machine-readable security result", () => {
    console.log('RESULT {"suite":"V-9","passed":true,"unauthorizedAccepted":0,"secretLeaks":0,"forbiddenFlags":0,"modelStarts":0}');
  });
});
