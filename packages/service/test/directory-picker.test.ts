import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickNativeDirectory } from "../src/directory-picker.ts";
import { createCollabServer } from "../src/server.ts";

describe("native project/workspace directory picker", () => {
  it("is session and CSRF gated, canonicalizes a selection, and preserves cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "collab-directory-picker-"));
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-alias");
    mkdirSync(workspace, { mode: 0o700 });
    symlinkSync(workspace, alias, "dir");
    const selections: Array<string | null> = [alias, null];
    const app = createCollabServer({
      stateFile: join(root, "events.sqlite"),
      directoryPicker: async () => selections.shift() ?? null,
    });
    const address = await app.listen();

    try {
      const unauthorized = await fetch(`${address.url}/api/workspace/pick`, {
        method: "POST",
      });
      expect(unauthorized.status).toBe(403);

      const bootstrap = await fetch(`${address.url}/bootstrap`, {
        method: "POST",
        headers: {
          Origin: address.url,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ capability: app.sessions.capability }),
      });
      const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
      const { csrf } = (await bootstrap.json()) as { csrf: string };

      const missingCsrf = await fetch(`${address.url}/api/workspace/pick`, {
        method: "POST",
        headers: {
          Origin: address.url,
          Cookie: cookie,
        },
      });
      expect(missingCsrf.status).toBe(403);

      const selected = await fetch(`${address.url}/api/workspace/pick`, {
        method: "POST",
        headers: {
          Origin: address.url,
          Cookie: cookie,
          "X-Collab-CSRF": csrf,
        },
      });
      expect(selected.status).toBe(200);
      expect(await selected.json()).toEqual({
        canceled: false,
        path: realpathSync(workspace),
      });

      const cancelled = await fetch(`${address.url}/api/workspace/pick`, {
        method: "POST",
        headers: {
          Origin: address.url,
          Cookie: cookie,
          "X-Collab-CSRF": csrf,
        },
      });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toEqual({ canceled: true });
    } finally {
      await app.close();
    }
  });

  it("fails safely when the host platform has no supported picker", async () => {
    await expect(pickNativeDirectory("aix")).rejects.toThrow(
      "DIRECTORY_PICKER_UNSUPPORTED_PLATFORM",
    );
  });
});
