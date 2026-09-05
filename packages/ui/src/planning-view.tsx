import type { RunProjection } from '@collab/contracts';
import { useState } from 'preact/hooks';

/** Safe Markdown subset: all source text remains Preact text nodes, never innerHTML. */
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g).map((part,i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2,-2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1,-1)}</code>;
    const link=part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;
    return part;
  });
}
export function Markdown({ text }: { text: string }) {
  const lines=text.split('\n');const blocks:any[]=[];let i=0;
  const row=(line:string)=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
  while(i<lines.length) {
    const line=lines[i]!;
    if(!line.trim()){i++;continue;}
    if(line.startsWith('```')) {const code:string[]=[];i++;while(i<lines.length&&!lines[i]!.startsWith('```'))code.push(lines[i++]!);i++;blocks.push(<pre><code>{code.join('\n')}</code></pre>);continue;}
    const heading=line.match(/^(#{1,6})\s+(.+)$/);
    if(heading){blocks.push(heading[1]!.length>=3?<h4>{inline(heading[2]!)}</h4>:<h3>{inline(heading[2]!)}</h3>);i++;continue;}
    if(line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i+1]??'')) {
      const headers=row(line);i+=2;const rows:string[][]=[];while(i<lines.length&&lines[i]!.includes('|')&&lines[i]!.trim())rows.push(row(lines[i++]!));
      blocks.push(<div class="document-table" role="region" aria-label="Plan table" tabIndex={0}><table><thead><tr>{headers.map(h=><th scope="col">{inline(h)}</th>)}</tr></thead><tbody>{rows.map(cells=><tr>{headers.map((_,index)=><td>{inline(cells[index]??'')}</td>)}</tr>)}</tbody></table></div>);continue;
    }
    if(/^\s*(?:[-*]|\d+\.)\s/.test(line)) {
      const ordered=/^\s*\d+\./.test(line);const entries:any[]=[];
      while(i<lines.length&&/^\s*(?:[-*]|\d+\.)\s/.test(lines[i]!))entries.push(<li>{inline(lines[i++]!.replace(/^\s*(?:[-*]|\d+\.)\s+/,''))}</li>);
      blocks.push(ordered?<ol>{entries}</ol>:<ul>{entries}</ul>);continue;
    }
    const paragraph=[line];i++;while(i<lines.length&&lines[i]!.trim()&&!/^(?:#|```|[-*] |\d+\. )/.test(lines[i]!))paragraph.push(lines[i++]!);
    blocks.push(<p>{inline(paragraph.join('\n'))}</p>);
  }
  return <div class="document-markdown">{blocks}</div>;
}
export function PlanningView({ run, onExport }: { run: RunProjection; onExport: () => void }) {
  const p = run.planning!;
  const [revisionNumber, setRevisionNumber] = useState<number | null>(null);
  const current = p.documents.at(-1);
  const doc = p.documents.find(d => d.number === revisionNumber) ?? current;
  const reviews = doc ? p.reviews.filter(r => r.revision === doc.revision && (r.contextVersion ?? 0) === p.answers.length) : [];
  const usage = p.steps.filter(s => s.phase === 'usage');
  const attempts = Object.values(run.budgets.provider).reduce((n,b)=>n+b.consumed,0);
  const total = usage.reduce((n,s) => n+s.usage.input+s.usage.cachedInput+s.usage.output,0);
  const list = (items: string[]) => items.length ? <ul>{items.map((item,i) => <li key={i}>{item}</li>)}</ul> : <p>None recorded.</p>;
  return <>
    <section class="planning-document" aria-labelledby="document-heading">
      <p class="eyebrow">Your answer or plan</p>
      <h2 id="document-heading">{doc?.title ?? (run.completedAt ? 'No completed document' : 'Building the first answer')}</h2>
      <div class="planning-status" aria-label="Document status">
        <span>Result: <strong>{p.status === 'ready' ? 'Ready for your consideration' : doc ? 'Draft or partial' : 'Pending'}</strong></span>
        <span>Provider agreement: {p.agreement}</span>
        <span>Required conditions: {p.fulfillment}</span>
      </div>
      {doc ? <>
        <div class="button-row">
          <label>Document revision <select value={doc.number} onChange={e => setRevisionNumber(Number(e.currentTarget.value))}>{p.documents.map(d => <option value={d.number}>Revision {d.number}{d.number === current?.number ? ' (current)' : ''}</option>)}</select></label>
          <button type="button" onClick={onExport}>Export Markdown</button>
        </div>
        <Markdown text={doc.body} />
        <h3>Practical next steps</h3>{list(doc.nextSteps)}
        <h3>Assumptions</h3>{list(doc.assumptions)}
        <h3>Changes caused by review</h3>{list(doc.changes)}
        <h3>Remaining questions and disagreements</h3>{list([...new Set([...doc.unresolved, ...p.issues])])}
        {run.goal?.completionEvidence.length ? <><h3>Required conditions</h3>{list(run.goal.completionEvidence.map(condition => { const c=doc.conditions.find(c=>c.condition===condition); return `${condition}: ${c?.status ?? 'unconfirmed'} — ${c?.reason ?? 'No fulfillment assessment returned'}`; }))}</> : null}
        <h3>Review of this revision</h3>
        {(['codex','claude'] as const).map(role => { const r=reviews.find(r=>r.reviewer===role); return <article class="planning-review" key={role}><h4>{role}: {r?.verdict.replaceAll('_',' ') ?? 'Pending — no approval recorded'}</h4><p>{r?.rationale}</p>{r?.objections.length ? list(r.objections.map(o=>`${o.severity}: ${o.issue} Suggested correction: ${o.correction}`)) : null}</article>; })}
      </> : <p>{run.state === 'preflight_blocked' ? 'Provider readiness must be resolved before collaboration can start. No second-provider approval has been inferred.' : 'Independent proposals, concrete reviews, and revisions will appear here as they finish.'}</p>}
      <p class="document-caveat">Review expresses the providers’ judgments against the available evidence. Agreement does not establish that every claim is true. Implementing this plan requires a separate request.</p>
    </section>
    <details class="planning-details"><summary>Evidence and claim support</summary>
      {doc ? list(doc.claims.map(c=>`${c.text} — ${c.status}; references: ${c.evidenceIds.join(', ') || 'none'}`)) : null}
      {list(p.contextNotes)}
      {p.context.map(e=><details key={e.id}><summary>{e.id}: {e.source} ({e.status})</summary><pre>{e.content}</pre><small>Snapshot SHA-256: {e.sha256}</small></details>)}
    </details>
    <details class="planning-details"><summary>Messages, provider activity, usage, and diagnostics</summary>
      <p>{usage.length} provider calls returned; {total.toLocaleString()} input, cached input, and output tokens reported; {Math.round(usage.reduce((n,s)=>n+s.durationMs,0)/1000)} seconds in returned calls. Reasoning tokens, where reported, are a subset of output.</p>
      <p>Usage coverage: {usage.length===attempts && usage.every(s=>s.usageComplete) ? 'Complete for returned calls' : 'Incomplete; missing usage is not zero'}. Interrupted calls may have consumed unreported usage.</p>
      {(['codex','claude'] as const).map(role=><details key={role}><summary>{role}: {run.workers[role].activity ?? run.workers[role].state}; billing {run.billing[role]?.simulated ? 'simulated fixture' : run.billing[role]?.route ?? 'unchecked'}</summary><pre>{JSON.stringify(run.billing[role],null,2)}</pre></details>)}
      {p.answers.map(a=><article><h3>User clarification</h3><p>{a.question}</p><p>{a.answer}</p></article>)}
      {p.steps.filter(s=>!['usage','provider_response'].includes(s.phase)).map(s=><details key={s.key}><summary>{s.role}: {s.phase.replaceAll('_',' ')}</summary><pre>{JSON.stringify(s.output,null,2)}</pre></details>)}
      <details><summary>Original provider responses before validation</summary>{p.steps.filter(s=>s.phase==='provider_response').map(s=><pre key={s.key}>{JSON.stringify(s.output,null,2)}</pre>)}</details>
      {p.reviews.map((r,i)=><details key={i}><summary>{r.reviewer}: {r.verdict} · {r.revision.slice(0,12)}</summary><pre>{JSON.stringify(r,null,2)}</pre></details>)}
    </details>
  </>;
}
