/** Bounded app-path live smoke. Requires a current, explicit authorization file. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createCollabServer } from '../packages/service/src/server.ts';
import { globalModelStartGuard } from '../packages/adapters/src/model-guard.ts';
const file=process.argv[process.argv.indexOf('--authorization')+1];
if (!process.argv.includes('--authorization') || !file) throw new Error('CURRENT_SESSION_AUTHORIZATION_REQUIRED');
const auth=JSON.parse(readFileSync(file,'utf8'));
if(auth.kind!=='planning-smoke' || Date.now()>Date.parse(auth.expiresAt) || auth.maxScenarios>3 || auth.maxCalls>10 || auth.subscriptionOnly!==true) throw new Error('INVALID_SMOKE_AUTHORIZATION');
const evidence=resolve(auth.evidenceDirectory);mkdirSync(evidence,{recursive:true});
const usedFile=join(evidence,'authorization-used.json');
writeFileSync(usedFile,JSON.stringify({authorizedAt:auth.authorizedAt,startedAt:new Date().toISOString()},null,2),{flag:'wx',mode:0o600});
const app=createCollabServer({stateFile:join(evidence,'state.sqlite'),uiDirectory:resolve('packages/ui/dist'),planning:{codexBinary:'/Applications/ChatGPT.app/Contents/Resources/codex',subscriptionOnly:true,maxCalls:auth.maxCalls,maxRevisions:1,outputWords:550}});
const address=await app.listen();const browser=await chromium.launch({headless:true});
let runId:string|undefined;
try {
 const page=await browser.newPage({viewport:{width:1360,height:1000}});await page.goto(address.launchUrl);
 await page.getByLabel('What would you like help answering, deciding, or planning?').fill('Help me create a practical four-week plan to learn basic spreadsheet skills from scratch. I can study two hours per week. My rough note says this gives me twelve total hours, so please check that assumption. Use only this supplied context; no current product recommendations or external facts are needed. Give a realistic schedule, concrete practice tasks, a progress check, and important assumptions. Keep meaningful tradeoffs visible.');
 await page.getByText('Context and limits',{exact:true}).click();
 await page.getByLabel('Stop after provider work (minutes, default 12)').fill('8');
 await page.getByLabel('Required conditions (optional, one per line)').fill('Fit the plan into two hours per week for four weeks.\nCorrect the total-hours calculation.');
 await page.getByRole('button',{name:'Start collaboration'}).click();
 const deadline=Date.now()+9*60_000;let previous='';
 while(Date.now()<deadline) {
  runId=app.store.listRunIds()[0];
  if(runId) {
   const p=app.store.projection(runId);const state=`${p.state}; ${p.planning?.steps.filter(s=>s.phase!=='usage').map(s=>s.key).join(',')}`;
   if(state!==previous) {console.log(state);previous=state;}
   if(p.completedAt || p.actions.length)break;
  }
  await new Promise(r=>setTimeout(r,1000));
 }
 if(!runId)throw new Error('RUN_NOT_CREATED');
 const p=app.store.projection(runId);
 writeFileSync(join(evidence,'projection.json'),JSON.stringify(p,null,2)+'\n');
 writeFileSync(join(evidence,'events.json'),JSON.stringify(app.store.events(runId),null,2)+'\n');
 writeFileSync(join(evidence,'result.json'),JSON.stringify({kind:'live provider smoke through browser and HTTP service',runId,state:p.state,status:p.planning?.status,guard:globalModelStartGuard.snapshot(),qualityClaim:'Feasibility only; no controlled comparison or human preference ratings.',completedAt:p.completedAt,issues:p.planning?.issues,actions:p.actions},null,2)+'\n');
 await page.screenshot({path:join(evidence,'live-ui.png'),fullPage:true});
 console.log(JSON.stringify({runId,state:p.state,modelStarts:globalModelStartGuard.started,actions:p.actions}));
 if(!p.completedAt && !p.actions.length)await app.coordinator.cancelRun(runId);
} finally {await browser.close();await app.close();}
