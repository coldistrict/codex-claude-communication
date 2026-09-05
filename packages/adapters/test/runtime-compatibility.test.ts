import { describe,it,expect,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkCodexContract, observeRuntime } from '../src/runtime.ts';
import { modelCallStructure } from '../../../tools/model-call-structure.ts';
import { evaluateCodexPreflight, evaluateClaudePreflight } from '../src/policy.ts';
import { ClaudeAgentAdapter, parseClaudeBillingUsage } from '../src/claude-adapter.ts';

describe('measured runtime compatibility and billing diagnostics',()=>{
  it('checks the generated Codex contract and detects removed request fields',()=>{
    const schema=JSON.parse(readFileSync(new URL('../../../artifacts/planning-2026-09-04/codex-schema/codex_app_server_protocol.v2.schemas.json',import.meta.url),'utf8'));
    expect(checkCodexContract(schema)).toEqual([]);delete schema.definitions.TurnStartParams.properties.outputSchema;expect(checkCodexContract(schema)).toContain('turn/start structured output and input');
  });
  it('does not report a missing runtime as a successful pin check',async()=>{const r=await observeRuntime('codex','/missing/runtime');expect(r.versionMatches).toBe(false);expect(r.schemaMatches).toBe(false);expect(r.trace.join()).toContain('runtime probe');});
  it('recognizes actual invocations and ignores turn/started notification data',()=>{
    expect(modelCallStructure('if (method === "turn/started") notify();')).toMatchObject({turnStarts:0,turnLiterals:0});
    expect(modelCallStructure('return this.request("turn/start", {});')).toMatchObject({turnStarts:1,turnLiterals:1});
    expect(modelCallStructure('const method = "turn/start";')).toMatchObject({turnStarts:0,turnLiterals:1});
    expect(modelCallStructure('query({prompt}); query({prompt:noModelMessages()});')).toMatchObject({modelQueries:1,metadataQueries:1});
  });
  const codex={versionMatches:true,schemaMatches:true,forbiddenEnvironment:[],spawnArgs:[],effectiveProviderOverride:false,subscriptionsRegistered:true,account:{type:'chatgpt',planType:'prolite',requiresOpenaiAuth:true},rateLimits:{structurallyTrusted:true,planType:'prolite',primary:{usedPercent:19},credits:{hasCredits:false,unlimited:false}}};
  it('distinguishes signed-in unknown plans from absent authentication',()=>{
    expect(evaluateCodexPreflight(codex).ok).toBe(true);
    expect(evaluateCodexPreflight({...codex,account:{...codex.account,planType:'unseen'}}).predicate).toBe('codex.unknown_subscription_plan');
    expect(evaluateCodexPreflight({...codex,account:null}).predicate).toBe('codex.subscription_auth_unproven');
    expect(evaluateCodexPreflight({...codex,rateLimits:{...codex.rateLimits,planType:'plus'}}).predicate).toBe('codex.billing_metadata_changed');
  });
  it('treats missing or changed usage metadata as unknown, and exhausted windows as limits',()=>{
    expect(parseClaudeBillingUsage({rate_limits_available:true,rate_limits:{five_hour:{utilization:100}}})).toMatchObject({includedUsageRemaining:false,currentRoute:null});
    expect(parseClaudeBillingUsage({rate_limits_available:true,rate_limits:{unknown:{changed_percent:5}}})).toMatchObject({includedUsageRemaining:null,currentRoute:null});
  });
});

describe('prepaid credit proof',()=>{
 it('does not confuse a monthly spending cap with a funded balance',()=>{
  const parsed=parseClaudeBillingUsage({rate_limits_available:true,rate_limits:{five_hour:{utilization:100},extra_usage:{is_enabled:true,monthly_limit:10000,used_credits:0,utilization:0}}});
  expect(parsed.existingCreditsRemaining).toBeNull();expect(parsed.currentRoute).toBeNull();
 });
});


describe('diagnostic causes survive failed metadata probes',()=>{
 it('does not turn a failed auth-status command into a fabricated logged-out result',async()=>{
  const adapter=new ClaudeAgentAdapter({cwd:'/tmp'});
  vi.spyOn(adapter,'authStatus').mockRejectedValue(new Error('METADATA_NETWORK_TIMEOUT'));
  const result=await adapter.metadataPreflight({versionMatches:false,sdkMatches:false,forbiddenEnvironment:[],spawnArgs:[],apiKeyHelperPresent:false,effectiveProviderOverride:false,subscriptionsRegistered:true});
  expect(result.ok).toBe(false);expect(result.predicate).toBe('claude.auth_metadata_unavailable');expect(result.trace.join()).toContain('METADATA_NETWORK_TIMEOUT');
 });
});
