import type { PlanningProjection, DocumentRevision, PlanningDocument, PlanningReview } from '@collab/contracts';
import { digest } from './canonical.ts';

export function initialPlanning(): PlanningProjection {
  return { context: [], contextNotes: [], steps: [], documents: [], reviews: [], answers: [], extensionFocus: null, status: 'working', agreement: 'pending', fulfillment: 'pending', evidenceStatus: 'not_assessed', issues: [] };
}
export function documentDigest(document: PlanningDocument): string {
  const { title, body, assumptions, nextSteps, claims, conditions, dispositions, changes, unresolved } = document;
  return digest({ title, body, assumptions, nextSteps, claims, conditions, dispositions, changes, unresolved });
}
export function assessDocument(planning: PlanningProjection, required: string[]) {
  const doc = planning.documents.at(-1);
  const reviews = doc ? planning.reviews.filter(r => r.revision === doc.revision && (r.contextVersion ?? 0) === planning.answers.length) : [];
  const issues: string[] = [];
  if (!doc?.body.trim()) issues.push('No readable answer or plan was returned.');
  for (const condition of required) {
    if (doc?.conditions.find(c => c.condition === condition)?.status !== 'met' ||
      ['codex', 'claude'].some(role => reviews.find(r => r.reviewer === role)?.conditions.find(c => c.condition === condition)?.status !== 'met')) {
      issues.push(`Required condition is unmet or unconfirmed: ${condition}`);
    }
  }
  const agreement = ['codex', 'claude'].every(role => reviews.some(r => r.reviewer === role && r.verdict === 'approved')) ? 'agreed' as const : reviews.length === 2 ? 'disagreed' as const : 'pending' as const;
  const material = reviews.flatMap(r => r.objections.filter(o => o.severity === 'material').map(o => `${r.reviewer}: ${o.issue}`));
  issues.push(...material);
  const unresolved = doc?.unresolved ?? [];
  issues.push(...unresolved);
  const fulfillment = doc?.body.trim() && !issues.some(i => i.startsWith('Required condition')) ? 'met' as const : 'unmet' as const;
  const evidenceStatus = doc?.claims.some(c => c.status === 'unsupported') ? 'unsupported_claims' as const : 'supplied_context' as const;
  return { agreement, fulfillment, evidenceStatus, issues, status: agreement === 'agreed' && fulfillment === 'met' && material.length === 0 ? 'ready' as const : 'partial' as const };
}
export function validateDocument(doc: DocumentRevision, required: string[], evidenceIds: string[]): void {
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(i => typeof i === 'string');
  if (doc.schemaVersion !== 1 || !Number.isSafeInteger(doc.number) || doc.number < 1 ||
    typeof doc.title !== 'string' || typeof doc.body !== 'string' || !doc.body.trim() || doc.body.length > 100_000 ||
    !strings(doc.assumptions) || !strings(doc.nextSteps) || !strings(doc.changes) || !strings(doc.unresolved) ||
    !Array.isArray(doc.claims) || !Array.isArray(doc.conditions) || !Array.isArray(doc.dispositions)) throw new Error('DOCUMENT_INVALID_OR_EMPTY');
  for (const c of doc.claims) if (typeof c.text !== 'string' || !strings(c.evidenceIds) || !['supported','unsupported','inference'].includes(c.status) || c.evidenceIds.some(id => !evidenceIds.includes(id)) || (c.status === 'supported' && !c.evidenceIds.length)) throw new Error('DOCUMENT_CLAIM_EVIDENCE_INVALID');
  for (const c of doc.conditions) if (!required.includes(c.condition) || !['met','unmet','unknown'].includes(c.status) || typeof c.reason !== 'string') throw new Error('DOCUMENT_CONDITION_INVALID');
  for (const d of doc.dispositions) if (typeof d.objectionId !== 'string' || !['addressed','retained','withdrawn'].includes(d.disposition) || !d.reason?.trim()) throw new Error('DOCUMENT_DISPOSITION_INVALID');
  if (new Set(doc.dispositions.map(d => d.objectionId)).size !== doc.dispositions.length) throw new Error('DOCUMENT_DUPLICATE_DISPOSITION');
  if (doc.revision !== documentDigest(doc)) throw new Error('DOCUMENT_REVISION_MISMATCH');
}
export function validateReview(review: PlanningReview, doc: DocumentRevision, required: string[], evidenceIds: string[]): void {
  if (review.revision !== doc.revision || !['codex','claude'].includes(review.reviewer) || !['approved','revision_requested','disagreement','needs_input'].includes(review.verdict) || !review.rationale?.trim() || !Array.isArray(review.objections) || !Array.isArray(review.conditions)) throw new Error('REVIEW_INVALID');
  for (const o of review.objections) if (!o.id?.trim() || !o.issue?.trim() || !o.correction?.trim() || !['material','minor'].includes(o.severity) || !Array.isArray(o.evidenceIds) || o.evidenceIds.some(id => !evidenceIds.includes(id))) throw new Error('REVIEW_OBJECTION_INVALID');
  if (new Set(review.objections.map(o => o.id)).size !== review.objections.length) throw new Error('REVIEW_DUPLICATE_OBJECTION');
  if (review.verdict === 'approved' && review.objections.some(o => o.severity === 'material')) throw new Error('REVIEW_APPROVAL_WITH_MATERIAL_OBJECTION');
  if (review.verdict === 'revision_requested' && !review.objections.some(o => o.severity === 'material')) throw new Error('REVIEW_REJECTION_REQUIRES_SPECIFIC_ISSUE');
  for (const c of review.conditions) if (!required.includes(c.condition) || !['met','unmet','unknown'].includes(c.status) || typeof c.reason !== 'string') throw new Error('REVIEW_CONDITION_INVALID');
}
export function documentMarkdown(planning: PlanningProjection): string {
  const doc = planning.documents.at(-1);
  if (!doc) return '# No document yet\n';
  const list = (items: string[]) => items.length ? items.map(s => `- ${s}`).join('\n') : 'None recorded.';
  return `# ${doc.title}\n\n${doc.body}\n\n## Next steps\n\n${list(doc.nextSteps)}\n\n## Assumptions\n\n${list(doc.assumptions)}\n\n## Review changes\n\n${list(doc.changes)}\n\n## Open questions and disagreements\n\n${list([...doc.unresolved, ...planning.issues])}\n\n## Required conditions\n\n${list(doc.conditions.map(c => `${c.condition}: ${c.status} — ${c.reason}`))}\n\n## Claims and evidence\n\n${list(doc.claims.map(c => `${c.text} (${c.status}; ${c.evidenceIds.join(', ') || 'no supporting reference'})`))}\n\n${list(planning.context.map(e => `[${e.id}] ${e.source} (${e.status}, SHA-256 ${e.sha256})`))}\n\n## Reviewer verdicts\n\n${list(planning.reviews.filter(r => r.revision === doc.revision && (r.contextVersion ?? 0) === planning.answers.length).map(r => `${r.reviewer}: ${r.verdict} — ${r.rationale}`))}\n\nRevision ${doc.number}: ${doc.revision}\n\nAgreement: ${planning.agreement}. Fulfillment: ${planning.fulfillment}. Evidence: ${planning.evidenceStatus}. These are model judgments against supplied context, not independent fact verification.\n`;
}
