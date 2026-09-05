import type { PlanningDocument, ProviderRole } from '@collab/contracts';
import type { PlanningPort, PlanningCall } from '../src/planning-runner.ts';
export function fixtureDocument(body = 'Choose a small goal. Spend thirty minutes practising each weekday. Review progress after two weeks.', conditions: string[] = []): PlanningDocument {
  return { title: 'A practical starting plan', body, assumptions: ['A small, reversible trial is acceptable.'], nextSteps: ['Choose a measurable goal and schedule the first session.'], claims: [{ text: 'This plan is a proposal, not a verified outcome.', evidenceIds: ['E1'], status: 'inference' }], conditions: conditions.map(condition=>({condition,status:'met',reason:'Addressed explicitly in the body.'})), dispositions: [], changes: [], unresolved: [] };
}
export function fixturePort(options: { reject?: boolean; alwaysReject?: boolean; empty?: boolean; unmet?: boolean; disagree?: boolean; clarify?: boolean; unavailable?: boolean; unchanged?: boolean; fail?: boolean; conditions?: string[]; calls?: PlanningCall[] } = {}): PlanningPort {
  const calls=options.calls ?? [];
  const conditions=options.conditions ?? [];
  return {
    async preflight() {
      const result=(provider:ProviderRole)=>({ok: !(options.unavailable && provider==='claude'),provider,trace:['deterministic fixture; zero model calls'],billing:{provider,route:'subscription_allowance' as const,authenticatedBy:provider==='codex'?'chatgpt' as const:'claude.ai' as const,plan:'fixture',simulated:true,proof:['SIMULATED; not live billing'],checkedAt:new Date().toISOString()},remedy:'Fixture provider unavailable'});
      return {codex:result('codex'),claude:result('claude')};
    },
    async call(input) {
      calls.push(input);
      if(options.fail) throw new Error('FIXTURE_FAILURE');
      const task=JSON.parse(input.prompt.slice(input.prompt.lastIndexOf('\n\n')+2));
      let result: any = fixtureDocument(undefined,conditions);
      if(options.clarify && !task.userAnswers.length && input.role==='codex') return {output:{question:'How many hours per week can you commit?',result:null},usage:{input:100,cachedInput:0,output:20,reasoning:0}};
      if(input.phase==='review' || input.phase==='cross_review') {
        const number=task.task.document?.number ?? 0;
        const rejected=input.phase==='review' && input.role==='claude' && (options.alwaysReject || options.reject && number===1);
        result={verdict:rejected?'revision_requested':options.disagree && input.phase==='review' && input.role==='claude'?'disagreement':'approved',rationale:rejected?'The schedule exceeds the time available.':options.disagree?'Speed and depth remain a legitimate preference tradeoff.':'The document meets the supplied brief.',objections:rejected?[{id:'time',severity:'material',issue:'The schedule exceeds the available time.',correction:'Reduce scope and revise the schedule.',evidenceIds:['E1']}]:[],conditions:conditions.map(condition=>({condition,status:options.unmet?'unmet':'met',reason:options.unmet?'Required evidence is unavailable.':'Present in the document.'}))};
      }
      if(input.phase==='synthesis' && options.empty) result.body='';
      if(input.phase==='revision') {
        result.body=options.unchanged?fixtureDocument().body:`Revised plan ${task.task.previous.number+1}: reduce the schedule to two short sessions per week. Keep a progress log and review it after two weeks.`;
        result.changes=['Reduced scope after the reviewer identified the schedule problem.'];
        result.dispositions=task.task.reviews.flatMap((r:any)=>r.objections.map((o:any)=>({objectionId:o.id,disposition:'addressed',reason:'The body now uses a smaller schedule.'})));
      }
      if(options.unmet && ['synthesis','revision'].includes(input.phase)) result.conditions=result.conditions.map((c:any)=>({...c,status:'unmet',reason:'Required source unavailable.'}));
      return {output:{question:'',result},usage:{input:100,cachedInput:0,output:50,reasoning:0},usageComplete:true};
    },
    async close() {},
  };
}
