import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const runFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function canonical(x: any): any { return Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x; }
export interface RuntimeObservation { versionMatches: boolean; schemaMatches: boolean; sdkMatches: boolean; version: string; schemaHash?: string; sdkVersion?: string; trace: string[] }
const cache = new Map<string, RuntimeObservation>();
export function checkCodexContract(schema: any): string[] {
  const d = schema.definitions;
  const checks: Record<string, boolean> = {
    'thread/start cwd+sandbox+approvalPolicy': ['cwd','sandbox','approvalPolicy','config','developerInstructions'].every(k => d?.ThreadStartParams?.properties?.[k]),
    'turn/start structured output and input': ['threadId','input','outputSchema','serviceTier'].every(k => d?.TurnStartParams?.properties?.[k]),
    'rate limits structured windows': ['primary','secondary','credits','planType'].every(k => d?.RateLimitSnapshot?.properties?.[k]),
    'plan enum includes observed prolite': d?.PlanType?.enum?.includes('prolite'),
  };
  return Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
}
export async function observeRuntime(provider: 'codex' | 'claude', binary: string): Promise<RuntimeObservation> {
  try {
    const pins = JSON.parse(await readFile(join(root, 'pin-manifest.json'), 'utf8'));
    const info = await stat(binary);
    const key = `${provider}:${binary}:${info.size}:${info.mtimeMs}:${JSON.stringify(pins[provider])}`;
    if (cache.has(key)) return cache.get(key)!;
    const { stdout } = await runFile(binary, ['--version'], { timeout: 10000 });
    const version = stdout.trim();
    let result: RuntimeObservation;
    if (provider === 'codex') {
      const dir = await mkdtemp(join(tmpdir(), 'collab-schema-'));
      try {
        await runFile(binary, ['app-server','generate-json-schema','--out',dir], { timeout: 30000 });
        const schema = JSON.parse(await readFile(join(dir,'codex_app_server_protocol.v2.schemas.json'),'utf8'));
        const schemaHash = hash(JSON.stringify(canonical(schema)));
        const missing = checkCodexContract(schema);
        result = { version, schemaHash, versionMatches: version === pins.codex.version, schemaMatches: !missing.length && schemaHash === pins.codex.combinedSchemaCanonicalSha256, sdkMatches: true, trace: [`installed ${version}`, `schema SHA-256 ${schemaHash}`, ...missing.map(m => `missing contract: ${m}`)] };
      } finally { await rm(dir, { recursive: true, force: true }); }
    } else {
      const sdk = JSON.parse(await readFile(join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),'utf8'));
      const cliHash = hash(await readFile(binary));
      result = { version, sdkVersion: sdk.version, versionMatches: version.split(' ')[0] === pins.claude.bundledCliVersion && cliHash === pins.claude.bundledCliSha256, sdkMatches: sdk.version === pins.claude.sdkVersion, schemaMatches: true, trace: [`installed ${version}`, `SDK ${sdk.version}`, `CLI SHA-256 ${cliHash}`] };
    }
    cache.set(key, result); return result;
  } catch (error) { return { version: 'unavailable', versionMatches: false, schemaMatches: false, sdkMatches: false, trace: [`runtime probe: ${error instanceof Error ? error.message.split('\n')[0] : 'failed'}`] }; }
}
