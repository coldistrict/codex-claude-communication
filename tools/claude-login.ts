import { spawn } from "node:child_process";
import {
  bundledClaudeCliPath,
  scrubProviderEnvironment,
} from "../packages/adapters/src/index.ts";

const scrubbed = scrubProviderEnvironment(process.env);
if (scrubbed.forbiddenPresent.length) {
  throw new Error(
    `CLAUDE_LOGIN_FORBIDDEN_ENVIRONMENT:${scrubbed.forbiddenPresent.join(",")}`,
  );
}
const child = spawn(bundledClaudeCliPath(), ["auth", "login"], {
  env: scrubbed.env,
  stdio: "inherit",
});
const result = await new Promise<number>((resolve) => {
  child.once("exit", (code) => resolve(code ?? 1));
});
process.exitCode = result;
