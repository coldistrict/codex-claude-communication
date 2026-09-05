import { describe,it,expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, assessDocument, documentDigest } from '@collab/kernel';
import { exportRun } from '@collab/migration';
import { Coordinator } from '../src/coordinator.ts';
import { normalizeClaimSupport } from '../src/planning-runner.ts';
import type { PlanningCall, PlanningOptions } from '../src/planning-runner.ts';
import { fixturePort } from './planning-fixture.ts';

function setup(options: Parameters<typeof fixturePort>[0] = {}, more: Partial<PlanningOptions> = {}) {
  const root=mkdtempSync(join(tmpdir(),'planning-regression-'));
  const calls: PlanningCall[]=[];
  const store=new EventStore(join(root,'test.sqlite'));
  const coordinator=new Coordinator(store,{codexBinary:'/unused',planning:{portFactory:()=>fixturePort({...options,calls}),...more}});
  const id=coordinator.createRun({goal:'Create a practical learning plan from a rough goal.', completionEvidence:options?.conditions ?? []},true);
  const run=()=> (coordinator as any).planner().run(id);
  return {root,calls,store,coordinator,id,run};
}
async function settle(f: ReturnType<typeof setup>) {
  for(let i=0;i<200;i++) { const p=f.store.projection(f.id); if(p.completedAt || p.actions.length)return;await new Promise(r=>setTimeout(r,5)); }
  throw new Error('Fixture did not settle');
}
describe('planning workflow through the coordinator and event store (zero live calls)',()=>{
  it('creates a plan without a project; independently proposes, cross-reviews, then reviews exact content',async()=>{
    const f=setup();await f.run();const p=f.store.projection(f.id);
    expect(p.state).toBe('completed_consensus');expect(p.goal?.projectContext).toBe(null);expect(p.goal?.authority.writableRoots).toEqual([]);
    expect(f.calls.map(c=>c.phase)).toEqual(['proposal','proposal','cross_review','cross_review','synthesis','review','review']);
    const contexts=f.calls.slice(0,2).map(c=>JSON.parse(c.prompt.split('\n\n').at(-1)!));expect(contexts[0]).toEqual(contexts[1]);expect(contexts[0].task).toBeNull();
    expect(p.planning?.reviews.every(r=>r.revision===p.planning!.documents[0]!.revision)).toBe(true);f.store.close();
  });
  it('cannot complete successfully with an empty substantive result',async()=>{const f=setup({empty:true});await f.run();const p=f.store.projection(f.id);expect(p.completedAt).toBeNull();expect(p.actions[0]?.body).toContain('EMPTY');expect(p.planning?.documents).toHaveLength(0);f.store.close();});
  it('keeps failed required conditions visible even with both provider approvals',async()=>{const f=setup({unmet:true,conditions:['Use verified field evidence']},{maxRevisions:1});await f.run();const p=f.store.projection(f.id);expect(p.state).toBe('completed_disagreement');expect(p.planning?.fulfillment).toBe('unmet');expect(p.planning?.issues.join()).toContain('Use verified field evidence');f.store.close();});
  it('rejection produces a changed candidate and renewed reviews, invalidating prior approval',async()=>{const f=setup({reject:true});await f.run();const p=f.store.projection(f.id).planning!;expect(p.documents).toHaveLength(2);expect(p.documents[0]?.revision).not.toBe(p.documents[1]?.revision);expect(p.reviews).toHaveLength(4);expect(p.status).toBe('ready');const interim={...p,documents:p.documents,reviews:p.reviews.slice(0,2)};expect(assessDocument(interim,[]).agreement).toBe('pending');expect(p.documents[1]?.dispositions[0]?.objectionId).toBe('1:claude:time');f.store.close();});
  it('rejects a revision that only changes metadata',async()=>{const f=setup({reject:true,unchanged:true});await f.run();expect(f.store.projection(f.id).actions[0]?.body).toContain('UNCHANGED');expect(f.store.projection(f.id).completedAt).toBeNull();f.store.close();});
  it('preserves legitimate disagreement without inventing consensus or endless revision',async()=>{const f=setup({disagree:true});await f.run();const p=f.store.projection(f.id);expect(p.state).toBe('completed_disagreement');expect(p.planning?.reviews.find(r=>r.reviewer==='claude')?.rationale).toContain('preference tradeoff');expect(f.calls).toHaveLength(7);f.store.close();});
  it('a bounded extension addresses the issue in a new revision, then stops',async()=>{const f=setup({alwaysReject:true});await f.run();let p=f.store.projection(f.id);expect(p.planning?.documents).toHaveLength(2);const card=p.actions[0]!;await expect(f.coordinator.decideAction(f.id,card.id,'Extend budget','')).rejects.toThrow('DETAILS');await f.coordinator.decideAction(f.id,card.id,'Extend budget','Make the plan fit the two-session limit.');await settle(f);p=f.store.projection(f.id);expect(p.planning?.documents).toHaveLength(3);expect(p.state).toBe('completed_disagreement');expect(f.calls).toHaveLength(13);f.store.close();});
  it('routes clarification to a real card and resumes the same stage with the supplied answer',async()=>{const f=setup({clarify:true});await f.run();const card=f.store.projection(f.id).actions[0]!;expect(card.kind).toBe('needs_input');await expect(f.coordinator.decideAction(f.id,card.id,'Answer','')).rejects.toThrow('DETAILS');await f.coordinator.decideAction(f.id,card.id,'Answer','Two hours each week.');await settle(f);expect(f.store.projection(f.id).state).toBe('completed_consensus');expect(f.calls[1]?.prompt).toContain('Two hours each week.');expect(f.calls.filter(c=>c.phase==='proposal')).toHaveLength(3);f.store.close();});
  it('persists and exports readable documents with matching revision history',async()=>{const f=setup({reject:true});await f.run();const p=f.store.projection(f.id);const exported=exportRun(f.store,f.id,join(f.root,'export'));expect(exported.files.some(p=>p.endsWith('document.md'))).toBe(true);expect(readFileSync(join(f.root,'export/document.md'),'utf8')).toContain(p.planning!.documents.at(-1)!.body);expect(f.store.verifyHashChain(f.id).ok).toBe(true);f.store.close();const reopened=new EventStore(join(f.root,'test.sqlite'));reopened.rebuildAllProjections();expect(reopened.projection(f.id).planning).toEqual(p.planning);reopened.close();});
  it('blocks honestly when a provider is unavailable and permits cancellation',async()=>{const f=setup({unavailable:true});await f.run();expect(f.calls).toHaveLength(0);expect(f.store.projection(f.id).state).toBe('preflight_blocked');expect(f.store.projection(f.id).planning?.reviews).toHaveLength(0);await f.coordinator.cancelRun(f.id);expect(f.store.projection(f.id).state).toBe('cancelled');f.store.close();});
  it('snapshots selected project sources without changing them; rejects symlink escapes',async()=>{const f=setup();const source=join(f.root,'source');mkdirSync(source);writeFileSync(join(source,'README.md'),'# Source\nRead only original.');const id=f.coordinator.createRun({goal:'Plan using supplied project.',workspace:source},true);await(f.coordinator as any).planner().run(id);expect(readFileSync(join(source,'README.md'),'utf8')).toBe('# Source\nRead only original.');expect(f.store.projection(id).planning?.context.some(e=>e.source==='README.md')).toBe(true);symlinkSync('/etc/hosts',join(source,'escape.txt'));expect(()=>f.coordinator.createRun({goal:'Plan',workspace:source,attachmentPaths:['escape.txt']},true)).toThrow('OUTSIDE');f.store.close();});
  it('binds native Codex clarification to the user answer instead of an empty object',async()=>{const f=setup();const response=(f.coordinator as any).handleCodexServerRequest(f.id,{method:'item/tool/requestUserInput',params:{questions:[{id:'hours',question:'Hours per week?'}]}});const card=f.store.projection(f.id).actions[0]!;await f.coordinator.decideAction(f.id,card.id,'Answer','3');expect(await response).toEqual({answers:{hours:{answers:['3']}}});f.store.close();});
});

describe('planning failure and recovery boundaries',()=>{
  it('resumes a saved clarification after a service restart',async()=>{
    const f=setup({clarify:true});await f.run();const card=f.store.projection(f.id).actions[0]!;f.store.close();
    const store=new EventStore(join(f.root,'test.sqlite'));const coordinator=new Coordinator(store,{codexBinary:'/unused',planning:{portFactory:()=>fixturePort({clarify:true})}});
    await coordinator.decideAction(f.id,card.id,'Answer','Two hours.');
    for(let i=0;i<200 && !store.projection(f.id).completedAt;i++) await new Promise(r=>setTimeout(r,5));
    expect(store.projection(f.id).planning?.status).toBe('ready');store.close();
  });
  it('cancels an active provider call, preserves earlier work, and starts no next stage',async()=>{
    let called=0,closed=false;let release:(value:any)=>void=()=>{};
    const f=setup({}, {portFactory:()=>({...fixturePort(),call:async()=>{called++;return new Promise(resolve=>{release=resolve;});},close:async()=>{closed=true;release({output:{question:'',result:null},usage:{input:0,cachedInput:0,output:0,reasoning:0}});}})});
    const work=f.run();for(let i=0;i<50 && !called;i++)await new Promise(r=>setTimeout(r,5));
    await f.coordinator.cancelRun(f.id);await work;expect(closed).toBe(true);expect(called).toBe(1);expect(f.store.projection(f.id).state).toBe('cancelled');f.store.close();
  });
  it('refuses forged completion and stale document reviews at the durable boundary',async()=>{
    const f=setup({alwaysReject:true});await f.run();const p=f.store.projection(f.id);const old=p.planning!.reviews[0]!;
    expect(()=>f.store.append({runId:f.id,actor:old.reviewer,type:'document_reviewed',idempotencyKey:'stale',payload:{review:old}})).toThrow();
    expect(()=>f.store.append({runId:f.id,actor:'coordinator',type:'completed',idempotencyKey:'forged',payload:{outcome:'completed_consensus'}})).toThrow('DOCUMENT_COMPLETION');f.store.close();
  });
  it('allows an audit to report an incidental failed check without treating it as a missing condition',async()=>{
    const f=setup();await f.run();const p=f.store.projection(f.id).planning!;
    p.documents.at(-1)!.body='Audit finding: the check failed. Investigate the failure before deployment.';
    expect(assessDocument(p,[]).fulfillment).toBe('met');f.store.close();
  });
});

describe('live-trial regressions',()=>{
 it('allows disclosed ordinary unknowns when both reviewers approve and required conditions are met',async()=>{
  const f=setup();await f.run();const p=f.store.projection(f.id).planning!;p.documents.at(-1)!.unresolved=['Application access and actual learning pace are unverified.'];
  const assessment=assessDocument(p,[]);expect(assessment.status).toBe('ready');expect(assessment.issues).toContain('Application access and actual learning pace are unverified.');f.store.close();
 });
 it('namespaces identical cross-review objection IDs before synthesis',async()=>{
  const port=fixturePort();const seen:any[]=[];
  const f=setup({}, {portFactory:()=>({...port,call:async input=>{
   const r=await port.call(input);const envelope=r.output as any;
   if(input.phase==='cross_review')envelope.result.objections=[{id:'O1',severity:'minor',issue:'Clarify the tradeoff.',correction:'Keep the tradeoff visible.',evidenceIds:['E1']}];
   if(input.phase==='synthesis') {const task=JSON.parse(input.prompt.split('\n\n').at(-1)!).task;seen.push(...task.crossReviews.flatMap((s:any)=>s.output.objections.map((o:any)=>o.id)));}
   return r;
  }})});await f.run();expect(seen).toEqual(['0:cross:codex:O1','0:cross:claude:O1']);expect(f.store.projection(f.id).planning?.status).toBe('ready');f.store.close();
 });
});


describe('third live trial regression',()=>{
 it('retains a self-contained plan with an uncited claim as explicitly unsupported rather than rejecting the entire answer',()=>{
  const recorded=JSON.parse(readFileSync(new URL('./fixtures/planning-uncited-claim.json',import.meta.url),'utf8'));
  const original=recorded.result.body;normalizeClaimSupport(recorded.result,['E1']);
  expect(recorded.result.body).toBe(original);expect(recorded.result.claims[1].status).toBe('unsupported');expect(recorded.result.unresolved.join()).toContain('no cited source');
 });
});


it('replays the rejected live proposal through the complete corrected coordinator path with fixture peers',async()=>{
 const recorded=JSON.parse(readFileSync(new URL('./fixtures/planning-uncited-claim.json',import.meta.url),'utf8'));
 const conditions=recorded.result.conditions.map((c:any)=>c.condition);
 const base=fixturePort({conditions});
 const f=setup({conditions},{portFactory:()=>({...base,call:async input=>input.phase==='proposal'&&input.role==='codex'?{output:structuredClone(recorded),usage:{input:100,cachedInput:0,output:100,reasoning:0}}:base.call(input)})});
 await f.run();const p=f.store.projection(f.id);expect(p.planning?.status).toBe('ready');
 const proposal=p.planning!.steps.find(s=>s.key==='0|proposal:codex')!.output as any;expect(proposal.claims[1].status).toBe('unsupported');expect(proposal.body).toBe(recorded.result.body);
 expect(p.planning!.steps.some(s=>s.phase==='provider_response')).toBe(true);f.store.close();
});
