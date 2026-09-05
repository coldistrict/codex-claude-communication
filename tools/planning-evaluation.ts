/** Small paired evaluation. Default prepares a protocol; live execution requires explicit budget authorization. */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PlanningDocument, ProviderRole } from '@collab/contracts';
import { EventStore } from '@collab/kernel';
import { Coordinator } from '../packages/service/src/coordinator.ts';
import { PlanningRunner, planningSchema, realPlanningPort, type PlanningPort, type PlanningCall } from '../packages/service/src/planning-runner.ts';
export const qualityCases = [
 { id:'rough-goal', brief:'I want to learn spreadsheets from scratch in four weeks, with two hours per week. Create a practical plan with small practice tasks and a progress check.', required:['Fit the plan into eight total hours.'], correction:'No seeded error; judge practicality and unnecessary overhead.' },
 { id:'seeded-mistake', brief:'Review this proposal: three workshops with eight participants each need thirty-two seats. We have twenty-four seats available. Decide whether we need another room and explain the calculation.', required:['Correct the participant count using the supplied numbers.'], correction:'3 × 8 = 24; the stated count of 32 is wrong.' },
 { id:'ambiguous', brief:'Help me plan the launch. I have not decided what is launching, for whom, or when. Ask for the material information needed before proposing a substantive launch plan.', required:['Identify the missing launch subject and audience.'], correction:'A material clarification is useful; invented launch details are unsupported.' },
 { id:'tradeoffs', brief:'Choose between a two-week modest prototype that teaches us quickly and a six-week polished prototype that offers a more representative user experience. Both are affordable; our priority between speed of learning and realism remains undecided. Explain the tradeoff without pretending there is one uniquely correct choice.', required:['Keep the preference-dependent tradeoff visible.'], correction:'A conditional recommendation is legitimate; agreement is not proof of quality.' },
];
export type QualityCondition='single'|'self-review'|'two-provider';
export interface QualityResult { caseId:string; condition:QualityCondition; provider:ProviderRole; body:string; question:string|null; document:PlanningDocument|null; calls:number; budgetCalls:number; latencyMs:number; usage:unknown; usageComplete:boolean; errors:string[]; usefulCorrections:string[]; unsupportedClaims:string[]; humanUsefulness:null; humanPreference:null }
export function writeBlindPacket(results:QualityResult[],dir:string) {
 mkdirSync(dir,{recursive:true});const shuffled=[...results];for(let i=shuffled.length-1;i>0;i--){const j=randomInt(i+1);[shuffled[i],shuffled[j]]=[shuffled[j]!,shuffled[i]!];}
 const key:any[]=[];const rows=['answer_id,case_id,usefulness_1_to_5,useful_corrections,unsupported_claims,preference,notes'];
 for(const result of shuffled) {const id=randomBytes(4).toString('hex');const label=`answer-${id}`;writeFileSync(join(dir,`${label}.md`),`# ${result.caseId}\n\n${result.question ? `Clarification requested: ${result.question}` : result.body}\n`);key.push({answerId:label,...result});rows.push(`${label},${result.caseId},,,,,`);}
 writeFileSync(join(dir,'human-ratings.csv'),rows.join('\n')+'\n');writeFileSync(join(dir,'condition-key.json'),JSON.stringify(key,null,2)+'\n');
}
export async function evaluateBaseline(input:{caseIndex:number;condition:'single'|'self-review';provider:ProviderRole;port:PlanningPort;cwd:string;maxWords:number}):Promise<QualityResult> {
 const test=qualityCases[input.caseIndex]!;const start=Date.now();let calls=0;let usage:any[]=[];let document:PlanningDocument|null=null;let question:string|null=null;const errors:string[]=[];
 const call=async(phase:PlanningCall['phase'],task:unknown)=>{
  calls++;
  const prompt=`Answer or plan from the supplied brief and evidence only. No tools, external research, or implementation. Be accurate, direct, useful and at most ${input.maxWords} words in the body. Mark inferences and unsupported claims honestly. Use only evidence ID E1 for supplied context. If material information is missing, return question with result=null. Otherwise question="". Review concrete mistakes and tradeoffs without inventing objections. Required conditions: ${JSON.stringify(test.required)}.\n\n${JSON.stringify({brief:test.brief,evidence:[{id:'E1',content:test.brief,status:'supplied'}],stage:phase,task})}`;
  const result=await input.port.call({runId:`eval-${test.id}-${input.condition}`,role:input.provider,key:`eval-${calls}`,phase,prompt,schema:planningSchema(phase),authorization:{id:randomBytes(12).toString('hex'),kind:'user_goal',runId:`eval-${test.id}-${input.condition}`,providers:[input.provider],recordedAt:new Date().toISOString()},signal:AbortSignal.timeout(120_000)});
  usage.push({tokens:result.usage,complete:result.usageComplete??true});
  return typeof result.output==='string'?JSON.parse(result.output.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')):result.output as any;
 };
 try {
  const preflight=await input.port.preflight();if(!preflight[input.provider].ok || preflight[input.provider].billing.route!=='subscription_allowance')throw new Error('SUBSCRIPTION_ROUTE_REQUIRED');
  const initial=await call('synthesis',null);question=initial.question||null;document=initial.result;
  if(!question && input.condition==='self-review') { const review=await call('review',document);question=review.question||null;if(!question && review.result.verdict==='revision_requested') {const revised=await call('revision',{previous:document,review:review.result});question=revised.question||null;document=revised.result;} }
 } catch(e) {errors.push(String(e));} finally {await input.port.close();}
 return {caseId:test.id,condition:input.condition,provider:input.provider,body:document?.body??'',document,question,calls,budgetCalls:input.condition==='single'?1:3,latencyMs:Date.now()-start,usage,usageComplete:usage.length===calls&&usage.every(u=>u.complete),errors,usefulCorrections:document?.changes??[],unsupportedClaims:document?.claims.filter(c=>c.status==='unsupported').map(c=>c.text)??[],humanUsefulness:null,humanPreference:null};
}
async function main() {
 const outIndex=process.argv.indexOf('--out');const out=resolve(outIndex>=0?process.argv[outIndex+1]!:'artifacts/planning-2026-09-04/quality-protocol');mkdirSync(out,{recursive:true});
 const protocol={status:'prepared; live comparison not run',cases:qualityCases,conditions:['single','self-review','two-provider'],outputWords:550,workBudgets:{single:{maxCalls:1},selfReview:{maxCalls:3},twoProvider:{maxCalls:10,maxRevisionCycles:1}},fairness:'Same brief, required conditions, supplied evidence, no tools, and output-body length cap. Work budgets intentionally differ and must be reported alongside quality. Balance baseline provider and synthesis role across paired batches.',metrics:['useful corrections (model-reported; human check)','unsupported claims','human usefulness','human preference','body words','latency','actual provider usage and missing coverage'],blinding:'Review only answer-*.md plus human-ratings.csv. Keep condition-key.json hidden until ratings are entered.',conclusion:'No superiority or user preference has been established.'};
 writeFileSync(join(out,'protocol.json'),JSON.stringify(protocol,null,2)+'\n');
 if(!process.argv.includes('--live')) {console.log('Prepared quality protocol; zero model calls.');return;}
 const index=process.argv.indexOf('--authorization');if(index<0)throw new Error('EXPLICIT_COMPARISON_BUDGET_REQUIRED');const auth=JSON.parse(readFileSync(process.argv[index+1]!,'utf8'));
 if(auth.kind!=='planning-quality-comparison'||Date.now()>Date.parse(auth.expiresAt)||!Array.isArray(auth.caseIndices)||auth.caseIndices.length>4||!['codex','claude'].includes(auth.provider)||!Number.isInteger(auth.maxCalls)||auth.maxCalls<14*auth.caseIndices.length)throw new Error('INVALID_COMPARISON_AUTHORIZATION');
 writeFileSync(join(out,'live-authorization-used.json'),JSON.stringify({at:new Date().toISOString()}),{flag:'wx'});
 const results:QualityResult[]=[];const provider=auth.provider as ProviderRole;let spent=0;
 for(const caseIndex of auth.caseIndices) {
  if(!Number.isInteger(caseIndex)||!qualityCases[caseIndex])throw new Error('UNKNOWN_CASE');
  for(const condition of ['single','self-review','two-provider'] as const) {
   if(spent>=auth.maxCalls)throw new Error('EVALUATION_BUDGET_EXHAUSTED');
   const cwd=join(out,`${caseIndex}-${condition}`);mkdirSync(cwd,{recursive:true});
   const options={codexBinary:'/Applications/ChatGPT.app/Contents/Resources/codex',subscriptionOnly:true,maxCalls:10,maxRevisions:1,outputWords:550,synthesisRole:provider};
   if(condition!=='two-provider')results.push(await evaluateBaseline({caseIndex,condition,provider,cwd,maxWords:550,port:realPlanningPort(options,cwd)}));
   else {
    const test=qualityCases[caseIndex]!;const store=new EventStore(join(cwd,'state.sqlite'));const coordinator=new Coordinator(store,{codexBinary:options.codexBinary});const id=coordinator.createRun({goal:test.brief,completionEvidence:test.required,stopConditions:{maxDurationMinutes:8}},true);const started=Date.now();const runner=new PlanningRunner(store,options);await runner.run(id);const p=store.projection(id).planning!;const doc=p.documents.at(-1)??null;const records=p.steps.filter(s=>s.phase==='usage');
    results.push({caseId:test.id,condition,provider,body:doc?.body??'',document:doc,question:store.projection(id).actions.find(a=>a.requiresDetailsFor?.includes('Answer'))?.body??null,calls:records.length,budgetCalls:10,latencyMs:Date.now()-started,usage:records.map(r=>r.usage),usageComplete:records.every(r=>r.usageComplete),errors:store.projection(id).actions.filter(a=>!a.requiresDetailsFor?.includes('Answer')).map(a=>a.body),usefulCorrections:doc?.changes??[],unsupportedClaims:doc?.claims.filter(c=>c.status==='unsupported').map(c=>c.text)??[],humanUsefulness:null,humanPreference:null});store.close();
   }
   const latest=results.at(-1)!;spent+=latest.calls;writeBlindPacket(results,join(out,'blind-review'));
   if(latest.errors.length) {console.log('Evaluation stopped on failure; no provider-route fallback.');return;}
  }
 }
 console.log(`Comparison outputs saved. ${spent} calls reported. Human ratings are blank; no automatic superiority conclusion.`);
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
