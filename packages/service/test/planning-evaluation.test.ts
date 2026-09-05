import { describe,it,expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qualityCases, evaluateBaseline, writeBlindPacket } from '../../../tools/planning-evaluation.ts';
import { fixtureDocument, fixturePort } from './planning-fixture.ts';
import { PlanningRunner, type PlanningPort } from '../src/planning-runner.ts';
import { Coordinator } from '../src/coordinator.ts';
import { EventStore } from '@collab/kernel';

describe('small quality evaluation protocol (fixtures are not quality evidence)',()=>{
 it('covers rough goals, seeded mistakes, ambiguity, and legitimate tradeoffs',()=>expect(qualityCases.map(c=>c.id)).toEqual(['rough-goal','seeded-mistake','ambiguous','tradeoffs']));
 it('records different work budgets and leaves human preferences blank in blind packets',async()=>{
  const port:PlanningPort={...fixturePort(),call:async input=>({output:{question:'',result:input.phase==='review'?{verdict:'revision_requested',rationale:'Fix the hours',objections:[],conditions:[]}:fixtureDocument()},usage:{input:100,cachedInput:10,output:50,reasoning:4}})};
  const dir=mkdtempSync(join(tmpdir(),'quality-packet-'));
  const single=await evaluateBaseline({caseIndex:0,condition:'single',provider:'codex',port,cwd:dir,maxWords:550});
  const self=await evaluateBaseline({caseIndex:0,condition:'self-review',provider:'codex',port,cwd:dir,maxWords:550});
  expect(single.calls).toBe(1);expect(self.calls).toBe(3);expect(single.humanPreference).toBeNull();
  writeBlindPacket([single,self],dir);const answers=readdirSync(dir).filter(n=>n.startsWith('answer-'));
  expect(answers).toHaveLength(2);for(const name of answers)expect(readFileSync(join(dir,name),'utf8')).not.toContain('self-review');
  expect(readFileSync(join(dir,'human-ratings.csv'),'utf8')).toContain(',,,,,');
 });
 it('can change the synthesis provider internally without changing the independent opening order',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'author-bias-'));const store=new EventStore(join(dir,'test.sqlite'));const coordinator=new Coordinator(store,{codexBinary:'/unused'});const id=coordinator.createRun({goal:'Create a plan.'},true);const runner=new PlanningRunner(store,{codexBinary:'/unused',synthesisRole:'claude',portFactory:()=>fixturePort()});await runner.run(id);expect(store.projection(id).planning?.documents[0]?.author).toBe('claude');expect(store.projection(id).planning?.status).toBe('ready');store.close();
 });
});
