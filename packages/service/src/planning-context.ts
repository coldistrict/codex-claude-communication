import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GoalPacket, PlanningEvidence } from '@collab/contracts';
import { redactSecrets } from '@collab/security';

/** Fixed evidence packet shared by both models. No provider receives filesystem tools. */
export function collectPlanningContext(goal: GoalPacket): { context: PlanningEvidence[]; notes: string[] } {
  const context: PlanningEvidence[] = [];
  const notes = ['Sources are read-only snapshots. No shell commands or web research run in the planning path. Claims beyond these sources must be marked as assumptions, inferences, or unsupported.'];
  const root = goal.projectContext;
  const add = (source: string, content: string, status: PlanningEvidence['status']) => {
    const safe = redactSecrets(content);
    context.push({ id: `E${context.length + 1}`, source, content: safe, sha256: createHash('sha256').update(safe).digest('hex'), status });
  };
  add('User brief and constraints', [goal.goal, ...goal.constraints].join('\n'), 'supplied');
  if (!root) return { context, notes };
  const names = readdirSync(root).filter(n => !n.startsWith('.') && !['node_modules','vendor','dist','build'].includes(n)).slice(0,100);
  add('Selected project: top-level inventory', names.join('\n'), 'observed');
  const selected = [...new Set([...(goal.attachments ?? []).map(a => a.path), ...names.filter(n => /^(readme)(\.(md|txt))?$/i.test(n))])];
  let total = 0;
  for (const name of selected) {
    const path = isAbsolute(name) ? name : resolve(root, name);
    const local = relative(root, path);
    if (local.startsWith(`..${sep}`) || local === '..' || isAbsolute(local) || /(^|[/\\])(\.env[^/]*|credentials[^/]*|auth\.json|.*\.(pem|key))$/i.test(local)) throw new Error('CONTEXT_PATH_FORBIDDEN');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || realpathSync(path) !== path || !stat.isFile()) throw new Error('CONTEXT_SYMLINK_OR_NOT_FILE');
    if (stat.size > 64_000 || total + stat.size > 160_000) { notes.push(`Source omitted because it exceeds the context budget: ${local}`); continue; }
    const bytes = readFileSync(path);
    const attached = goal.attachments?.find(a => a.path === name);
    if (attached && createHash('sha256').update(bytes).digest('hex') !== attached.sha256) throw new Error(`CONTEXT_CHANGED:${local}`);
    if (bytes.includes(0)) { notes.push(`Binary source omitted: ${local}`); continue; }
    total += bytes.length;
    add(local, bytes.toString('utf8'), 'observed');
  }
  return { context, notes };
}
