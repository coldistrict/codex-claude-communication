import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCollabServer } from '../packages/service/src/server.ts';
import { fixturePort } from '../packages/service/test/planning-fixture.ts';
const evidence=resolve('artifacts/planning-2026-09-04/browser');mkdirSync(evidence,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'planning-browser-'));
const options={stateFile:join(root,'test.sqlite'),uiDirectory:resolve('packages/ui/dist'),planning:{codexBinary:'/unused',portFactory:()=>fixturePort({clarify:true,reject:true})}};
let app=createCollabServer(options);let address=await app.listen();
const browser=await chromium.launch({headless:true});
try {
 const context=await browser.newContext({viewport:{width:1360,height:1000},reducedMotion:'reduce'});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(address.launchUrl);await page.getByRole('heading',{name:'New collaboration'}).waitFor();
 const first=await new AxeBuilder({page:page as any}).analyze();assert.equal(first.violations.filter(v=>['serious','critical'].includes(v.impact??'')).length,0);
 await page.getByLabel('What would you like help answering, deciding, or planning?').fill('Help me create a learning plan from a rough goal.');
 // Optional workspace stays empty; submit via keyboard.
 await page.getByRole('button',{name:'Start collaboration'}).press('Enter');
 await page.getByRole('heading',{name:'A decision needs your input'}).waitFor();await page.getByLabel('Your answer').fill('Two hours each week.');
 await page.getByRole('button',{name:'Answer',exact:true}).click();
 await page.getByText('Ready for your consideration',{exact:true}).waitFor({timeout:20000});
 await page.getByRole('heading',{name:'A practical starting plan'}).waitFor();
 assert.equal(await page.locator('script[data-fixture]').count(),0);
 await page.getByLabel('Document revision').selectOption('1');await page.getByText('The schedule exceeds the time available.',{exact:true}).waitFor();
 await page.getByLabel('Document revision').selectOption('2');
 await page.getByRole('button',{name:'Export Markdown',exact:true}).click();await page.locator('.export-note').waitFor();
 const id=app.store.listRunIds()[0]!;const projection=app.store.projection(id);assert.equal(projection.planning!.documents.length,2);
 const body=readFileSync(join(root,'exports',id,'document.md'),'utf8');assert.ok(body.includes('Revised plan 2'));assert.ok(body.includes('claude: approved'));
 const axe=await new AxeBuilder({page:page as any}).analyze();const severe=axe.violations.filter(v=>['serious','critical'].includes(v.impact??''));assert.deepEqual(severe,[]);
 await page.screenshot({path:join(evidence,'document-desktop.png'),fullPage:true});
 await page.emulateMedia({colorScheme:'dark'});const dark=await new AxeBuilder({page:page as any}).analyze();assert.deepEqual(dark.violations.filter(v=>['serious','critical'].includes(v.impact??'')),[]);await page.screenshot({path:join(evidence,'document-dark.png'),fullPage:true});await page.emulateMedia({colorScheme:'light'});
 await page.setViewportSize({width:390,height:844});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);assert.ok(overflow<=1,`overflow ${overflow}`);await page.screenshot({path:join(evidence,'document-mobile.png'),fullPage:true});
 await app.close();app=createCollabServer(options);address=await app.listen();await page.goto(address.launchUrl);await page.getByRole('heading',{name:'A practical starting plan'}).waitFor();assert.equal(app.store.projection(id).planning!.documents.length,2);
 assert.deepEqual(errors,[]);
 writeFileSync(join(evidence,'result.json'),JSON.stringify({kind:'deterministic browser fixtures',modelStarts:0,passed:true,clarificationResumed:true,revisionChanged:true,exportVerified:true,historyRestored:true,optionalProject:true,seriousCriticalViolations:0,overflowPx:overflow,root},null,2)+'\n');console.log('RESULT planning-browser passed; zero model starts');
} finally {await browser.close();await app.close();}
