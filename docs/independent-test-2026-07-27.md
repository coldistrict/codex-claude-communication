# Independent test pass — 2026-07-27 (Claude, real providers)

Audit-only pass against the source state described in
`docs/implementation-handoff.md` §"Post-handoff hardening verified on the final
source state (2026-07-27)". **No source file was modified.** All 108 tracked
source files were byte-identical before and after (`baseline-hashes.txt` vs
`final-hashes.txt` in the evidence directory below). This document is the only
file added.

## Evidence

- Preserved test state (isolated; the normal app state directory was never
  created or touched):
  `/private/tmp/collab-independent-test-2026-07-27/collab-test-state`
- Contains `collab.sqlite` (both runs, core events + adviser sidecar + usage)
  and both runs' adviser note files.
- Service was launched with
  `COLLAB_STATE_DIR=<that path> COLLAB_PORT=47821`, driven through the real
  dashboard in a browser.

## What passed

Automated: `npm run build`, `npm test` (184 Vitest tests / 28 files — adapters
34, kernel 44, migration 5, security 4, service 97 — plus the V-11 browser
harness; every suite `modelStarts: 0`), `npm run verify:pins`,
`npm run verify:zero-call` (1 guarded Codex turn / 1 guarded Claude model query
/ 1 metadata-only Claude query / 0 forbidden billing calls, 23 files).

Real providers, both on proven subscription allowance (Codex ChatGPT Plus
`primary.usedPercent=30`; Claude Max, `authMethod=claude.ai`,
`apiProvider=firstParty`, `extraUsageEnabled=false`):

- **Codex adviser** (`gpt-5.6-sol`, medium) accepted the shared output schema.
  No `invalid_json_schema`, no `CODEX_TURN_FAILED`.
- **Claude adviser** (`claude-opus-5[1m]`, medium) returned 3 valid wakes.
- **Same-provider execution gate proven in both directions from timestamps**
  (see below), not from UI labels.
- **Separate accounting**: worker tokens in `usage_records`, adviser tokens in
  `advisor_usage`, zero adviser rows in the worker table, provider budgets
  ended 3/8 in both runs.
- **Terminal retrospective** fired on both terminal kinds.
- **Live same-sequence UI refresh** observed twice with
  `performance.getEntriesByType('navigation').length === 1`.
- **overhead-gate-v2**: 1.0468438651562713× and 1.0485831008222382×, both
  `passedBy: "ratio"`, `coordinationTokenUpper: 0`, adviser tokens excluded.
- **Read-only enforcement**: zero workspace writes, zero approval events.
- Core hash chains `{ok:true,count:41}` ×2; adviser sidecar chains
  `{ok:true,count:9}` and `{ok:true,count:6}`.
- All 5 adviser observations cite only real event ids at seq ≤
  `observedThroughSeq`; zero unresolved.

### Run 1 — Codex adviser

`run_522e0540-2786-4b04-85f0-3d3ecacfb405` → `completed_consensus`
`14:48:49.910Z`. Goal: read `pin-manifest.json`; both providers agreed on
`collabdSchemaVersion` 2 and `codex-cli 0.146.0-alpha.3.1`.

| Fact | Timestamp |
|---|---|
| "Ask the adviser" pressed during the Codex candidate burst | `advisor_requested` `14:46:41.671Z` (burst claimed `14:46:39.479Z`, complete `14:47:07.174Z`) |
| Adviser wake claimed after the burst released the gate | `14:47:07.168Z` (6 ms before the burst-complete event) |
| Observation | `14:47:20.605Z` |
| Retrospective wake | claimed `14:48:49.914Z` (4 ms after `completed`), observation `14:48:56.347Z` |

Worker total 306,809 tokens / 6 bursts; `mixedCoordinatorBytes` 13,729 of
49,152. Adviser 2 wakes / 43,048 tokens (codex).

### Run 2 — Claude adviser

`run_11350a72-456a-4543-b97c-064c8f701633` → `completed_disagreement`
`14:55:01.167Z`. Goal: read `package.json`.

The workers reached an **explicit declared disagreement**, not consensus. This
is a legitimate terminal state, not a defect: Codex refused to sign because the
candidate recorded a glob beyond `package.json` (reading the goal's "read only
package.json" strictly), while Claude signed. Both positions were retained. The
adviser had already flagged the underlying ambiguity ("1 configured entry" vs
"7 resolved packages") in its first observation.

| Fact | Timestamp |
|---|---|
| "Ask the adviser" pressed during the Claude opening burst | `advisor_requested` `14:51:36.402Z` (burst claimed `14:51:10.082Z`, complete `14:51:39.763Z`) |
| **Gate deferred the adviser** 3.351 s | wake claimed `14:51:39.754Z` |
| **Gate deferred a worker** ~6.4 s | Claude worker claimed the ready queue at `14:52:00.112Z` *inside* the adviser window; its first provider runtime activity was `14:52:07.137Z` — 587 ms after the adviser released, 7,025 ms after the claim, against a 684–696 ms baseline for every other Claude claim. The 30 s activity-coalescing window had already elapsed, so the silence is real. |
| Disagreement-trigger wake | claimed `14:53:44.350Z`, observation `14:54:21.781Z` |
| Retrospective wake | claimed `14:55:01.170Z` (3 ms after `completed`), observation `14:55:37.827Z` |

Worker total 283,367 tokens / 6 bursts; `mixedCoordinatorBytes` 13,129 of
49,152. Adviser 3 wakes / 25,018 tokens (claude).

## Defect D-1 — adviser wake counter conflates the reserved retrospective with the reactive budget

**Severity:** cosmetic / user-visible reporting. No authority, enforcement, or
accounting impact — the server's budget arithmetic is correct.

**Symptom:** at the end of run 2 the dashboard read
`Wakes used: 3 of 2 reactive + 1 reserved retrospective` — three of two.

**Cause:** `packages/ui/src/app.tsx:853` renders
`advisorView.accounting.advisorUsage.wakeCount` against the reactive budget.
`wakeCount` is `claims.length` in `packages/kernel/src/advisor.ts:302`, i.e.
every claimed wake — including the reserved retrospective and any wake that
consumed no unit at all (preflight-blocked, model-profile-unavailable,
budget-exhausted).

The authoritative predicate is `AdvisorService.consumedWakeUnits`
(`packages/service/src/advisor/service.ts:626`): only `wake_outcome` rows with
`modelStarted === true`, split by `purpose`.

**Measured:**

| Run | UI showed | Reactive consumed | Retrospective consumed |
|---|---|---|---|
| `run_522e0540…` | 2 | 1 | 1 |
| `run_11350a72…` | 3 | 2 | 1 |

**Consequence:** the user is told the reactive budget is spent when it is not.
In run 1 one reactive unit remained while the UI implied both were gone.

**Smallest fix (UI only — no contract, kernel, or service change).** The ledger
is already delivered to the client as `advisorView.ledger`, so derive the count
with the same predicate the service uses and render that instead of
`wakeCount`:

```ts
const reactiveWakesUsed = (advisorView?.ledger ?? []).filter((row) => {
  const p = row.payload as { modelStarted?: boolean; purpose?: string };
  return row.kind === "wake_outcome"
    && p.modelStarted === true
    && p.purpose === "advisor_observation";
}).length;
```

Leave the "reserved retrospective" half of the line as the static budget, or
render the retrospective consumed count with the same predicate and
`purpose === "advisor_retrospective"`.

The larger alternative — adding `reactiveWakeCount` / `retrospectiveWakeCount`
to `AdvisorUsageReport` in `packages/kernel/src/advisor.ts` and the contracts —
is defensible if other consumers need the split, but it is not the minimal fix.

## Not tested (no verdict — do not record these as passing)

- **Retry after a recoverable Action Needed state.** Zero `needs_input` events
  occurred across both runs; no provider failure, limit pause, or preflight
  failure arose, so no card offering "Retry" ever appeared. The
  "recovery does not double-charge the original burst" property is
  **unverified against real providers** and remains covered only by the
  deterministic suites.
- **Codex emitting a literal `null` `recommendationCode`.** Both Codex
  observations carried a real code. Optionality is proven empirically on the
  Claude path (4 of 11 observations had the key entirely absent and passed) and
  by inspection of `validateAdvisorOutput`, which treats `undefined` and `null`
  identically for both providers — but the live Codex-null case was not seen.
- **Consensus was directly observed once** (run 1). Run 2 terminated in a
  declared disagreement.

## Operational note (not a defect)

The adapter correctly fail-closes when `ANTHROPIC_BASE_URL` is present
(`scrubProviderEnvironment` in `packages/adapters/src/policy.ts`). Shells that
export it — including the one Claude Code runs in — must launch the service
with `env -u ANTHROPIC_BASE_URL`, or the Claude route shows blocked with no
on-screen explanation of the cause. Worth a clearer message in the billing
card; the behaviour itself is right.

Also by design: `combinedCoordinationRatio` exceeded 1.05 in both runs (1.1937×
and 1.1412×). It is explicitly informational; the 1.05 promise is the
worker-loop gate, which passed both times.

## Process facts

- Zero V-13 canary runs; no authorization file was created, claimed, or reused.
- The only provider work was the two scenarios' bounded worker and adviser
  turns plus metadata-only preflights and catalog reads.
- Clean shutdown: the service and the Codex app-server it spawned both exited.
  ChatGPT.app's own long-running `app-server` (PID 82500, started well before
  this session) was deliberately left running.
