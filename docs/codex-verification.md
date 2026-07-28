# Codex adversarial remediation verification

Date: 2026-07-26  
Scope: remediation findings F-1 through F-12  
Verifier: Codex, independent of the original remediation implementation

## Executive verdict

The remediation was materially sound, but not complete as received. Direct
adversarial tests demonstrated additional defects in F-2, F-3, F-5, F-6, and
F-7; these were repaired and regression-tested in this pass. F-1, F-4, F-8,
F-9, F-10, and F-12 withstand the requested challenges. F-11 remains only
partially remediated because approved MVP UI surfaces are still absent.

The required aggregate at
`/private/tmp/codex-reverify-acceptance.json` reports:

- `deterministicPassed: true`
- `passed: true`
- V-13 evidence status `passed`
- metadata-only Codex and Claude readiness `true`
- `releaseReady: false`

The former `releaseReady: true` conclusion is not justified while F-11's
approved MVP surface remains incomplete. The aggregate now carries an
explicit `mvpSurface` blocker instead of treating test/evidence validity as a
substitute for feature completeness.

No V-13 canary was run. No provider model turn was started. The aggregate's
`v13.modelStarts: 10` is a sum from the two preserved evidence artifacts, not
new activity. Every suite run in this verification reported zero current
model starts; the provider doctor was metadata-only.

## Scope and protected-state checks

The complete approved planning corpus, review/remediation documents,
implementation, tests, recorded acceptance evidence, task notes/protocol,
generated Codex schema definitions relevant to auth/rate/usage/interrupt
semantics, and durable final-E2E state were inspected.

Protected files were hashed before any correction and again after the final
aggregate. All remained byte-identical:

| Protected file | SHA-256 |
|---|---|
| `tasks/.../final-plan.md` | `dcdee33eba3a75faafc125fdb9ba856e52475505ef4c7e48a2f4f372c9e8b943` |
| `tasks/.../verification.md` | `1f4b96d594d50c238b306a367bca53ee28318928cdfd813869f7cad49516e5a0` |
| `product/package-lock.json` | `8fc9a583680a6b6130a30461ac90c7196a6982133c3cc325442f016d93c0789f` |
| `product/artifacts/collab-acceptance.json` | `81c365a2738d212f3028c164815e37e573957d3d2ee4d9b9ff5fabb88bfad323` |
| `product/artifacts/v12-30m.json` | `5eef0b6bb6e0e06eebaccb170369642a9c72f03fd073ec10120a246f08e1c6bd` |
| `product/artifacts/v13-smoke.json` | `10386ce3ac09624e5cbbd804548d58d159d4c17dccbd60af93edf6220fb8b2c9` |
| `product/artifacts/v13-collab-e2e-attempt-1.json` | `909d4ec52e0d91a6f5207d5baba925991bdd610f02c12488e37205b8b4ae4d77` |
| `product/artifacts/v13-collab-e2e.json` | `869a1f640d928cbe9b8dc9234d5f58bc6fd14ec79e33595a045feec3a8676473` |

`/private/tmp/codex-remediation-acceptance.json` was not overwritten. The new
aggregate is mode `0600` at the separately requested path.

## Finding-by-finding disposition

### F-1 — Provider attribution

**Disposition: verified remediated.**

`ProviderFailure` carries the provider from the failing adapter/preflight call
site; `recordFailure` never routes by matching provider names in the error
text. Deterministic tests now cover both contradictory directions:

- a Codex failure containing “claude” and the repository path is attributed
  only to Codex;
- a Claude failure containing “codex” is attributed only to Claude.

The pause event, action-card `agent`, title, and worker state all agree with
the typed source role.

### F-2 — Durable recency, history, and action selection

**Disposition: verified after an additional repair in this pass.**

The SQLite query orders runs by durable `MAX(ts)` descending, the service
returns all projections, and the UI restores an action-needed run first on a
fresh load. A new multi-run Playwright probe found a separate race: a fast
SSE projection could arrive before the create response, after which the
create handler blindly prepended the same run. The durable DB was correct but
the UI rendered duplicate run entries.

The create handler now upserts by `runId`, matching the SSE and action-update
paths. The final V-11 probe proves:

- three runs survive service restart;
- the action-needed run is selected after reload;
- its action card survives;
- a completed run can be selected and its two packets are restored;
- `sseDuplicates: 0`.

### F-3 — Budget exhaustion actions

**Disposition: verified after an additional repair in this pass.**

The five approved actions remain present and the card displays both provider
counts and positions. `Supply information or authority` and `Decide` now
declare structured input requirements in `ActionCard`; the UI renders a
required textarea and disables only those actions while it is blank. The
server rejects blank input independently of the UI.

Supplied information is redacted, durably recorded in the user-authored
`human_override`, and included in resumed provider prompts without mutating
the immutable Goal Packet or expanding authority. Its full intervention
fragment is conservatively charged as a duplicate restatement in `C_upper`,
so this new path cannot evade overhead accounting. `Decide` durably records
the user's actual decision text before ending as explicit disagreement; it
does not manufacture provider consensus. Budget extension remains an audited
`+4` bursts per provider.

### F-4 — Simulated versus real preflight

**Disposition: verified remediated.**

Deterministic fixture billing is marked `simulated` in durable state, proof,
card copy, and the UI chip. A direct production-route probe confirms the
`fixture` retry parameter fails with `FIXTURE_PREFLIGHT_DISABLED` unless the
server explicitly opts into development fixtures. The release aggregate uses
provider-observed doctor metadata and preserved real-canary evidence; demo
preflight output cannot satisfy those predicates.

### F-5 — Causal usage attribution and coverage

**Disposition: verified after an additional repair in this pass.**

The received implementation checked that a claim named a durable claimed row
for the same run and role, but did not bind the claim's `triggerEventId` or
`wakeReason`. A forged burst could therefore reuse a different claimed row
from the same run/role and be counted as caused. A focused test reproduced
that false success.

`recordUsage` now also requires:

- a real stored `work_claimed`/`resumed` event;
- the expected coordinator/system actor and payload role;
- exact run and role;
- exact ready-work ID;
- exact trigger event;
- exact wake reason.

Missing, fabricated, wrong-run, wrong-role, swapped-trigger, swapped-reason,
and unclaimed cases fail the overhead gate. Structurally incomplete, invalid,
or all-zero usage fails coverage. The final E2E's durable history has six
model-wake events, six claimed ready rows, and six non-empty usage rows; the
artifact independently records six attempts/starts, six wake-latency samples,
and zero no-op invocations. Claude's `Agent` tool is disabled, and each
provider burst has one guarded adapter query/turn path, so there is no product
subagent usage tree omitted by this run.

### F-6 — Canary authorization claims and grandfathering

**Disposition: verified after an additional repair in this pass.**

The two exceptions are keyed only by the recomputed canonical evidence
digests:

- smoke: `8a7301d497640749eb5515495649b4d9906ca018426d928e928204a0d533cea5`;
- preserved failed attempt: `80c13bdf7343966baef7c9819442a1c2206c8210b2b77cc3ef606d690212af04`.

Object-key order and JSON whitespace are serialization, not semantic
evidence, so harmless reserialization retains the same canonical digest.
Any semantic change loses the exception. The tamper matrix now covers wrong
scope, stale authorization, expired/overbroad authorization, future/late
claim, claim before issuance, wrong authorization digest, missing claim,
missing claim marker/output paths, changed result content, and an attempt to
relabel the earlier failed E2E as passing even after recomputing its digest.

A strict claim must contain absolute marker and evidence-output paths, a
`.consumed` marker path, the bound authorization digest, and a valid
pre-observation timestamp. The final E2E has a strict claim at
`2026-07-26T16:16:04.228Z`, before its `2026-07-26T16:21:00.211Z`
observation. The grandfather caveat remains explicit: only the final E2E
empirically proves pre-observation one-use claiming; the smoke and failed
attempt predate that mechanism.

### F-7 — Cancellation contract

**Disposition: verified after an additional repair in this pass.**

The received remediation interrupted before `close()`, but the adapter still
spawned a child-scoped process, sent direct-child signals, and returned
immediately after `SIGKILL` without confirming exit. The service also wrote
`cancelled` and returned HTTP success before shutdown/reconciliation
finished.

The corrected path:

1. sends `turn/interrupt`;
2. waits the bounded active-turn grace;
3. sends `SIGTERM` to the detached app-server process group;
4. waits a bounded termination grace;
5. sends process-group `SIGKILL` only if needed;
6. waits for confirmed exit or throws `CODEX_PROCESS_EXIT_UNCONFIRMED`;
7. waits for the run failure/reconciliation path to settle before committing
   terminal cancellation.

If termination journals an uncertain mutation effect, the cancellation
remains nonterminal and preserves the reconciliation card rather than
clearing it with `cancelled`. Deterministic tests cover process-group
signalling, force-kill ordering, post-kill exit confirmation,
interrupt-before-close order, cancellation-after-settlement order, and
uncertain-card preservation.

### F-8 — Real overhead attribution

**Disposition: verified remediated.**

The original final-E2E database was quiescent (no WAL/SHM and no open writer
found) before a filesystem copy was made. The immutable copy at
`/private/tmp/codex-reverify-db-copy.4jmZLH/events.sqlite` passes SQLite
integrity checking and contains 38 hash-chained events and six usage rows.
The event chain ends at
`3f3b5471e4057084dcde69ea23ac935aeb790d652777bcd838540569d946ac5f`,
matching the evidence artifact.

Independent recomputation from those rows gives:

| Classifier | `T` | `C_upper` | Ratio | Verdict |
|---|---:|---:|---:|---|
| recorded `real-burst-v1` | 389,629 | 4,168 | 1.010813026479981 | pass |
| current `real-burst-v2` | 389,629 | 15,426 | 1.0412236139207862 | pass |

`T` includes input, cached input, output, and reasoning for all six bursts.
The v2 reconstruction matches the durable Goal Packet (1,045 JSON bytes),
Codex opening reconstruction, candidate/review manifest, manifest and
verification digests, and usage rows. It charges fixed instructions/labels,
the Goal Packet re-sent into resumed candidate/review sessions, Codex's own
opening re-sent to it, the manifest re-sent to its Claude author at signoff,
and all composed digest lines. Peer openings, candidate-to-review content,
and the reviewed manifest first sent to Codex remain useful first
transmissions under the plan's counterfactual. No other production prompt
fragment was found outside these fixed, duplicate, or useful-first buckets.

The review's 975-byte approximation would produce about 1.01595 when charged
twice more; the actual 1,045-byte Goal Packet produces about 1.01632 for that
isolated challenge. The full conservative v2 charge above remains below
1.05.

### F-9 — Claude auth predicate

**Disposition: verified remediated.**

The gate accepts exactly `authMethod === "claude.ai"` from
`claude auth status --json`; it does not use `tokenSource` or accept the
unproven literal `"oauth"`. The pinned SDK account type does not define an
alternative authoritative `authMethod` value. The final metadata-only doctor
observed `loggedIn=true`, `authMethod=claude.ai`,
`apiProvider=firstParty`, plan `max`, included usage remaining, and extra
usage disabled. With no primary evidence that the pinned runtime emits
`"oauth"` for the accepted subscription posture, the narrow fail-closed
predicate is correct.

### F-10 — Secondary Codex rate window

**Disposition: verified remediated.**

The adapter extracts primary and secondary windows. A present malformed
window blocks route proof; an absent optional secondary window is explicitly
reported; either window at 100% selects the existing-credit branch; and a
saturated window without existing credits blocks. The final doctor observed
primary usage at 89%, secondary absent, and subscription allowance active.

### F-11 — Advanced settings and legacy UI

**Disposition: partially remediated; release-blocking remainder.**

Implemented and reachable:

- per-provider and per-material-challenge budget controls;
- completed-run export through the service and UI;
- tested read/import/export migration library.

Still absent from the approved MVP:

- read-only legacy task-folder list/detail browser;
- permission-preset selection;
- stop-condition controls;
- attachment controls;
- resource-mode controls.

Implementing all of these during an adversarial repair pass would be an
expansive feature build rather than a surgical correction. Instead, the
aggregate now records these exact gaps in `mvpSurface` and refuses to emit
`releaseReady: true`.

### F-12 — Evidence ledger

**Disposition: verified remediated.**

The outcome view renders artifacts, the manifest evidence ledger,
verification ledger, known limitations, and exact manifest/verification
digests. Rendering remains text-only under the local CSP; the final V-11 run
reported zero serious/critical accessibility violations.

## Required verification battery

Final observed results:

- `npm run verify:pins` — pass; pinned Node/Codex/schema/Claude SDK/CLI
  hashes and versions match; zero model starts.
- `npm run build` — strict TypeScript and Vite production build pass.
- `npm test` — 97 Vitest cases pass across adapters, kernel, migration,
  security, and service; the V-11 Playwright script also passes.
- `npm run verify:zero-call` — pass; one guarded Codex turn-start site, one
  guarded Claude model-query site, one metadata-only Claude query site, zero
  forbidden billing calls.
- Required aggregate command — 19/19 suites pass, preserved V-12 reused,
  preserved V-13 evidence validates, metadata doctor passes, current model
  starts zero, `releaseReady: false`.

The first sandboxed `npm test` attempt was unable to bind loopback ports
(`EPERM`). The identical suite was rerun with permission to bind only its
local test servers and passed. This was an execution-environment restriction,
not a product failure.

## Files changed by this verification

Product corrections:

- `packages/adapters/src/codex-client.ts`
- `packages/contracts/src/index.ts`
- `packages/service/src/canary-evidence.ts`
- `packages/service/src/coordinator.ts`
- `packages/service/src/real-runner.ts`
- `packages/service/src/server.ts`
- `packages/ui/src/app.tsx`
- `packages/ui/src/styles.css`
- `tools/run-all.ts`

Focused regressions:

- `packages/adapters/test/codex-client.test.ts`
- `packages/security/test/security.test.ts`
- `packages/service/test/canary-evidence.test.ts`
- `packages/service/test/real-runner-causality.test.ts`
- `packages/ui/test/a11y.ts`

Documentation:

- `docs/implementation-handoff.md`
- `docs/codex-verification.md`

## Final release-readiness verdict

The deterministic implementation and preserved real-run evidence are valid
after the repairs above. That is not the same claim as full approved-MVP
completion. Because F-11 remains materially incomplete, the former
`releaseReady: true` verdict does **not** remain justified. The correct
current verdict is:

**Deterministic/evidence acceptance passed; product release readiness is
false pending the explicit F-11 surface gaps.**

---

## Follow-up: Claude third-pass verification and F-11 closure (2026-07-26)

This section is append-only. The 15,730-byte report above was not edited; its
pre-append SHA-256 was
`8d90e57e11b866384cf1b5841989b3484bacdfbce6e6480f75186cdc0d352059`.

### Third-pass corrections

**Provider-shutdown containment — defective at one terminal-order edge,
repaired.** All four fire-and-forget call sites (`createRun`, budget resume,
retry collaboration, and retry real preflight) invoke the same `runReal`, and
`runReal` catches escaped runner/cleanup failures, redacts the message, and
persists the "Provider shutdown did not confirm cleanly" card. The focused
regression passed.

Adversarial inspection found one remaining high-severity false-success edge:
`RealCollaborationRunner.collaborate` appended `completed_consensus` before
the `finally` block awaited `codex.close()`. If close then threw
`CODEX_PROCESS_EXIT_UNCONFIRMED`, `runReal` caught it but skipped its card
because the projection was already terminal; terminal store semantics also
prevented a late card. This was a silent cleanup failure despite the intended
containment. The repair defers `completed_consensus` until after confirmed
cleanup. A deterministic full-flow regression asserts `close()` observes
`completedAt === null`, then verifies consensus is committed after it returns.
Thus every production fire-and-forget route converges on containment while no
successful run can terminalize before cleanup.

**Cancel on uncertain-effect cards — verified and plan-consistent.** Cancel on
the reconciliation card itself first writes the user-authored
`human_override` decision
`acknowledge_uncertain_effect_and_cancel`, then writes `cancelled`. This is the
explicit user resolution required by plan §7 and does not manufacture success
or replay an effect. Cancel from any other card while an uncertain-effect card
is pending remains nonterminal and preserves reconciliation, satisfying the
plan §10 kill/reconciliation contract. The focused positive and preservation
regressions pass.

### F-11 implemented MVP surface

F-11 is now **remediated**:

- **Legacy task browser:** `CollabServerOptions.legacyTasksRoot` is the sole
  filesystem root and the shipped CLI exposes it only as the explicit
  `--legacy-tasks-root PATH` launch option. When unset, system capability is
  false and the routes return `LEGACY_TASKS_DISABLED`. When set, session-gated
  list/detail routes accept only immediate child IDs, canonicalize with
  `realpath`, and reject traversal and escaping symlinks. The UI renders goal,
  state, notes, transcript, final plan, and hashed files through escaped Preact
  text. A before/after inventory proves browsing performs zero historical
  writes.
- **Permission preset:** `default` retains the existing ask-on-first-mutation
  flow. `read_only` stores no writable root, supplies `read-only` to every
  Codex burst, denies every non-read approval at the bridge, and starts Claude
  in `dontAsk` with Bash/Write/Edit/NotebookEdit disallowed. Out-of-workspace
  reads fail containment rather than relying on string-prefix matching.
- **Attachments:** up to 20 regular-file references are resolved inside the
  canonical workspace, hashed, and stored immutably as relative path,
  SHA-256, size, and media type. References reach both provider sessions in
  the Goal Packet; fixture assertions confirm file bytes are not copied into
  prompts.
- **Stop condition:** the optional maximum provider-work duration starts only
  after successful metadata preflight. Expiry aborts Claude, interrupts then
  closes Codex, preserves any uncertain mutation card, and records the user's
  pre-authorized cancellation only after cleanup confirms. An unconfirmed
  close instead remains nonterminal through the containment card.
- **Resource mode:** `automatic` preserves parallel openings/signoffs unless
  the resource governor degrades. `serialized` mechanically awaits one
  provider burst before starting the other; the regression observes
  `maxActive === 1`.

The aggregate's former hand-maintained blocker is updated to
`mvpSurface.passed=true`, `blockingGaps=[]`, with the five implemented
capabilities listed in the output.

### Verification and release verdict

Observed on the final source state:

- focused third-pass/F-11/cleanup-order battery: 17/17 pass;
- `npm run verify:pins`: pass, `modelStarts: 0`;
- `npm run build`: pass;
- `npm test`: 104 Vitest tests plus V-11 pass; all machine-readable suites
  report `modelStarts: 0`;
- V-11: zero serious/critical accessibility findings, one live region, zero
  reflow overflow, hostile legacy markup escaped, advanced controls persisted;
- `npm run verify:zero-call`: pass at 1 guarded Codex turn site, 1 guarded
  Claude model-query site, 1 metadata-only Claude query, 0 forbidden billing
  calls;
- final metadata-only aggregate (with `ANTHROPIC_BASE_URL` removed only for
  that command):
  `/private/tmp/codex-f11-acceptance.json` — 19/19 pass,
  `v13Status: passed`, `mvpSurface.passed: true`,
  `releaseReady: true`.

No V-13 was run, no authorization file was created or reused, and no real
collaboration/provider model turn was initiated. The aggregate's
`modelStarts: 10` remains the four preserved smoke starts plus six preserved
final-E2E starts; the current doctor reports `modelStarts: 0` with both
metadata-only billing routes proven as `subscription_allowance`. Process
inspection found ambient ChatGPT and Claude Desktop provider processes whose
start times predate this pass; they were not launched, altered, or terminated
by this work.

The eight protected tripwires and acceptance artifacts were re-hashed after
all source, test, generated-UI, tool, and documentation changes and remain at
their required digests. The original body of this report remains the exact
pre-append byte prefix.

Files changed in this follow-up:

- contracts/kernel/adapters: `packages/contracts/src/index.ts`,
  `packages/kernel/src/store.ts`,
  `packages/adapters/src/claude-adapter.ts`;
- migration/service: `packages/migration/src/index.ts`,
  `packages/service/src/cli.ts`, `coordinator.ts`, `real-runner.ts`,
  `server.ts`;
- UI: `packages/ui/src/app.tsx`, `styles.css`, rebuilt `packages/ui/dist`;
- tests: `packages/service/test/mvp-surface.test.ts`,
  `real-runner.integration.test.ts`, `packages/ui/test/a11y.ts`;
- release/reporting: `tools/run-all.ts`,
  `docs/implementation-handoff.md`, and this append-only section.

**Final verdict:** Claude's uncertain-card Cancel correction is verified. Its
shutdown containment required the completion-order repair above. F-11's five
approved MVP gaps are now mechanically implemented and regression-tested, so
the explicit release blocker is closed and `releaseReady=true` is justified
by the final aggregate.
