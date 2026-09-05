import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural zero-call audit. In addition to the exact historical counts
 * (one guarded Codex turn site, one guarded Claude model-query site, one
 * metadata-only Claude query site, zero forbidden billing calls), it
 * enforces a file-and-symbol allowlist and rejects alias/computed-call
 * evasions, so a new provider model-bearing site cannot hide behind an
 * aliased import, a computed property, a rebound method, or a fragmented
 * method-name string.
 */
const here = dirname(fileURLToPath(import.meta.url));
const productRoot = resolve(here, "..");
const productionRoots = [
  join(productRoot, "packages", "adapters", "src"),
  join(productRoot, "packages", "service", "src"),
  join(productRoot, "packages", "service", "src", "advisor"),
];
const files: string[] = [];
for (const root of productionRoots) {
  for (const name of await readdir(root)) {
    if (name.endsWith(".ts")) files.push(join(root, name));
  }
}
const sources = new Map<string, string>();
for (const file of files) sources.set(file, await readFile(file, "utf8"));

function fail(reason: string, detail: unknown): never {
  throw new Error(`MODEL_GUARD_AUDIT_FAILED:${reason}:${JSON.stringify(detail)}`);
}

function countIn(pattern: RegExp, text: string): number {
  return text.match(pattern)?.length ?? 0;
}

function perFile(pattern: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [file, text] of sources) {
    const count = countIn(pattern, text);
    if (count > 0) counts.set(file, count);
  }
  return counts;
}

function assertOnlyIn(
  label: string,
  counts: Map<string, number>,
  expected: Record<string, number>,
): number {
  let total = 0;
  for (const [file, count] of counts) {
    const name = basename(file);
    if (expected[name] === undefined) {
      fail(`${label}:unexpected_file`, { file: name, count });
    }
    total += count;
  }
  for (const [name, count] of Object.entries(expected)) {
    const actual = [...counts].find(([file]) => basename(file) === name)?.[1] ?? 0;
    if (actual !== count) fail(`${label}:count`, { file: name, expected: count, actual });
  }
  return total;
}

// 1. The one guarded Codex turn/start site lives only in codex-client.ts.
const turnStarts = assertOnlyIn(
  "codex_turn_start",
  perFile(/request\("turn\/start"/g),
  { "codex-client.ts": 1 },
);
// Fragmented or computed method names cannot rebuild "turn/start" elsewhere:
// the exact substring may appear exactly once in production source, and no
// prefix fragment or computed indexing of the request method may appear.
assertOnlyIn("codex_turn_start_substring", perFile(/turn\/start/g), {
  "codex-client.ts": 1,
});
for (const [file, text] of sources) {
  if (/["'`]turn\/["'`]/.test(text)) fail("codex_turn_fragment", basename(file));
  if (/\brequest\s*\.\s*(?:bind|call|apply)\b/.test(text)) {
    fail("codex_request_rebound", basename(file));
  }
  if (/\[["'`]request["'`]\]/.test(text)) fail("codex_request_computed", basename(file));
}

// 2. Claude SDK query() sites: exactly two, both in claude-adapter.ts —
// one model-bearing (prompt: input.prompt) and one metadata-only
// (prompt: noModelMessages()).
const sdkQueries = assertOnlyIn("claude_query", perFile(/\bquery\(\{/g), {
  "claude-adapter.ts": 2,
});
// Since query() exists only inside claude-adapter.ts, the model/metadata
// prompt split is measured inside that file: exactly one model-bearing
// prompt and one metadata-only prompt.
const adapterSource =
  [...sources].find(([file]) => basename(file) === "claude-adapter.ts")?.[1] ?? "";
const sdkModelQueries = countIn(/prompt:\s*input\.prompt/g, adapterSource);
const sdkMetadataQueries = countIn(/prompt:\s*noModelMessages\(\)/g, adapterSource);
// The SDK may be imported only by claude-adapter.ts, without aliasing the
// query symbol, and never through require()/dynamic import.
for (const [file, text] of sources) {
  const name = basename(file);
  const importsSdk = /@anthropic-ai\/claude-agent-sdk/.test(text);
  if (importsSdk && name !== "claude-adapter.ts") {
    fail("claude_sdk_import_outside_adapter", name);
  }
  if (/\bquery\s+as\s+\w+/.test(text)) fail("claude_query_aliased", name);
  if (/\[["'`]query["'`]\]/.test(text)) fail("claude_query_computed", name);
  if (/\bquery\s*\.\s*(?:bind|call|apply)\b/.test(text)) {
    fail("claude_query_rebound", name);
  }
  if (/require\s*\(\s*["'`]@anthropic-ai/.test(text)) {
    fail("claude_sdk_required", name);
  }
  if (/import\s*\(\s*["'`]@anthropic-ai/.test(text)) {
    fail("claude_sdk_dynamic_import", name);
  }
}

// 3. Guard authorize sites: one per adapter, none anywhere else. Every model
// start flows through them, including adviser-profile bursts.
const guardCalls = assertOnlyIn(
  "guard_authorize",
  perFile(/\.authorize\("(?:codex|claude)"/g),
  { "codex-client.ts": 1, "claude-adapter.ts": 1 },
);
for (const [file, text] of sources) {
  if (/\bauthorize\s*\.\s*(?:bind|call|apply)\b/.test(text)) {
    fail("guard_authorize_rebound", basename(file));
  }
}

// 4. Provider process/spawn allowlist: only the two adapters may spawn or
// exec provider binaries or SDK runtimes.
assertOnlyIn("provider_spawn", perFile(/\bspawn\(/g), { "codex-client.ts": 1 });
assertOnlyIn("provider_exec_file", perFile(/\bexecFileAsync\(/g), {
  "claude-adapter.ts": 1,
  "directory-picker.ts": 1,
  "resources.ts": 1,
});

// 5. Forbidden billing calls stay absent everywhere.
const joined = [...sources.values()].join("\n");
for (const forbiddenCall of [
  'request("account/rateLimitResetCredit/consume"',
  'request("account/sendAddCreditsNudgeEmail"',
  'params: { type: "apiKey"',
]) {
  if (joined.includes(forbiddenCall)) throw new Error(`FORBIDDEN_PRODUCTION_CALL:${forbiddenCall}`);
}

if (
  turnStarts !== 1 ||
  sdkQueries !== 2 ||
  sdkModelQueries !== 1 ||
  sdkMetadataQueries !== 1 ||
  guardCalls !== 2
) {
  throw new Error(
    `MODEL_GUARD_AUDIT_FAILED:${JSON.stringify({
      turnStarts,
      sdkQueries,
      sdkModelQueries,
      sdkMetadataQueries,
      guardCalls,
    })}`,
  );
}
process.stdout.write(
  `RESULT ${JSON.stringify({
    suite: "zero-call-audit",
    passed: true,
    guardedCodexTurnStarts: turnStarts,
    guardedClaudeModelQueries: sdkModelQueries,
    metadataOnlyClaudeQueries: sdkMetadataQueries,
    forbiddenBillingCalls: 0,
    structural: {
      filesAudited: files.length,
      allowlistEnforced: true,
      aliasAndComputedCallRejection: true,
    },
  })}\n`,
);
