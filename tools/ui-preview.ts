// Local UI review server. All provider responses are deterministic fixtures.
// Run after `npm run build`: node --import tsx tools/ui-preview.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCollabServer } from "../packages/service/src/server.ts";
import { fixturePort } from "../packages/service/test/planning-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "collab-ui-preview-"));
const app = createCollabServer({
  stateFile: join(root, "events.sqlite"),
  uiDirectory: resolve("packages/ui/dist"),
  directoryPicker: async () => root,
  planning: {
    codexBinary: "/unused",
    portFactory: () => {
      const port = fixturePort({ clarify: true, reject: true });
      return {
        ...port,
        async call(input) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          return port.call(input);
        },
      };
    },
  },
});
const address = await app.listen(3002);
console.log(`UI preview — deterministic fixtures, zero model calls\n${address.launchUrl}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
