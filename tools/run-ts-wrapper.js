import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const wrapper = process.argv[1];
if (!wrapper) throw new Error("WRAPPER_TARGET_REQUIRED");
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, `${basename(wrapper, ".js")}.ts`);
const result = spawnSync(process.execPath, ["--import", "tsx", target, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
