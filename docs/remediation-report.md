# Remediation report — review findings F-1..F-12

Author: Claude (remediation session, 2026-07-26)
Responds to: `product/docs/claude-review.md` (independent adversarial review)
Companion: `product/docs/implementation-handoff.md` § "Post-review remediation (2026-07-26)"

All twelve findings were actioned on 2026-07-26. No V-13 canary was run, no
authorization was created or reused, no dependency, auth, or billing
configuration changed, and nothing under `product/artifacts/` was touched.
The line numbers cited in the review predate these changes and no longer
match; locate current code by symbol.

## Per-finding disposition

### F-1 — Fixed (provider attribution)

`packages/service/src/real-runner.ts`: new typed `ProviderFailure` error
carries the failing role from the call site. `executeProviderBurst` and both
`metadataPreflight` call sites (initial and `refreshBilling`) wrap errors via
`tagProviderFailures`. `recordFailure` reads the role only from the typed
error; the message-substring inference is deleted; the limit and
context-exhaustion branches require a known role, and coordinator-side
failures are no longer attributed to any provider (generic card, no `agent`).
Regression: `test/real-runner-causality.test.ts` reproduces the reviewer's
exact scenario — a Codex error whose text contains this repository's
"claude"-bearing path now pauses Codex, with Claude untouched.

### F-2 — Fixed (single-run dashboard)

`packages/ui/src/app.tsx`: run list/switcher (nav with per-run goal, state,
and pending-action count; `aria-current` on the selected run).
`packages/kernel/src/store.ts` `listRunIds()` orders by latest event
timestamp descending (so `/api/runs` is recency-ordered). Initial selection
prefers a run with pending action cards. Validated by the V-11 browser
harness (0 serious/critical axe findings on the new UI).

### F-3 — Fixed (budget exhaustion dead end)

`real-runner.ts` `recordFailure` catches `KernelError` code
`BUDGET_EXHAUSTED` and emits a dedicated `budget_exhausted` card
(`recordBudgetExhaustion`): per-provider consumed/remaining, issue counts
when present, both providers' latest recorded positions, and the five plan
§3.8 actions. `coordinator.ts` `decideAction` handles all five:

- "Extend budget": audited `budget_extended` +4/provider, resume.
- "Supply information or authority": audited `human_override`
  (`supply_information_or_authority`) + the same extension + resume; the
  user's answers reach providers through permission/needs-input cards.
- "Decide": audited `human_override` (`user_decided_outcome`) →
  `completed_disagreement` with both positions retained.
- "Accept disagreement" / "Cancel": unchanged existing semantics.

The infinite "Retry collaboration" loop is gone. Honest limitation
(recorded in the handoff): "Supply information or authority" has no
free-text input surface yet — it is an audited resume-with-extension, not a
structured information channel.

### F-4 — Fixed (fabricated billing proof)

`coordinator.ts` `retryPreflight` (the demo/fixture path) marks the durable
`BillingStatus` `simulated: true` (new optional contracts field), prepends a
"SIMULATED: deterministic demo fixture — not observed from any provider"
proof line, and titles cards "(demo)". The UI renders a dashed
"Demo billing — not a proven route" chip and never the proven-route label
for simulated statuses. `server.ts` gates the HTTP `fixture` parameter
behind the new `developmentFixtures` option (off in the shipped CLI;
requests without it get `FIXTURE_PREFLIGHT_DISABLED`). V-9 now asserts the
simulated markers; V-11 waits on the demo chip text.

### F-5 — Fixed (asserted integrity flags)

`real-runner.ts` `recordUsage` now takes the claiming `StoredEvent` and
derives every flag:

- `uncaused`: the claim's `readyWorkId` must resolve via the new
  `ReadyQueue.claimedItem()` (`packages/kernel/src/queue.ts`) to a durable,
  claimed ready-work row matching run and role, and the claim payload must
  carry `modelWake: true`. No claim, or a forged/unclaimed id → `uncaused`.
- `attributionComplete`: derived from the attribution content actually
  attached.
- `nestedUsageComplete`: derived from the provider having reported a
  structurally complete, non-zero usage object; an all-zero burst now fails
  the coverage gate instead of silently passing.

Claim events are threaded from every `claimModelWork` call site (openings,
candidate, review, both signoffs). Fixtures in
`test/real-runner-causality.test.ts` run a burst with no claim and with a
forged claim and assert the plan §8 gate FAILS; a zero-usage burst fails
coverage. The six-burst integration test now verifies causal wiring
end-to-end because the flags it asserts are derived. Honest limitation:
`nestedUsageComplete` proves usage was reported, not that no hidden nested
tree consumed usage; the canary's independent guard-versus-usage cross-check
remains the stronger property.

### F-6 — Fixed with exact-digest grandfathering (acceptance-sensitive)

`packages/service/src/canary-evidence.ts` `validateCanaryEvidence` now
requires `result.authorizationClaim` on every artifact (passed or failed),
asserts `claimedAt < observedAt` and `claimedAt ≥ issuedAt − 60 s`, and
binds `claim.authorizationDigest` to the evidence's authorization digest.
`GRANDFATHERED_CLAIMLESS_EVIDENCE` admits exactly two byte histories by
recomputed evidence digest, with recorded reasons:

- `8a7301d497640749eb5515495649b4d9906ca018426d928e928204a0d533cea5`
  (v13-smoke.json, observed 15:29:10Z, marker installed retroactively
  15:42Z)
- `80c13bdf7343966baef7c9819442a1c2206c8210b2b77cc3ef606d690212af04`
  (v13-collab-e2e-attempt-1.json, observed 15:35:45Z, preserved failed
  attempt, marker retroactive 15:42Z)

Grandfathering applies only when the recomputed digest matches, so any byte
change re-fails those artifacts. Validation results and the V-14 summary
surface `grandfatheredClaim` explicitly. Tests validate all three recorded
artifacts from disk: final E2E strict (claim present, bound, and
pre-observation), the two others grandfathered. V-14 result:
`v13Status: passed`, `releaseReady: true`. Honest weakening recorded in the
handoff: the "one-use authorization claimed before any model work" property
is empirically proven for exactly one of the three real runs.

### F-7 — Fixed (cancellation kill contract)

`packages/adapters/src/codex-client.ts`: the client tracks the in-flight
turn; new `interruptActiveTurn(graceMs = 3000)` sends `turn/interrupt` and
waits a bounded grace for completion; `close(graceMs = 2000)` escalates
SIGTERM → grace → SIGKILL and waits for exit. `real-runner.ts` `cancel()`
now: abort Claude → `interruptActiveTurn` → close (port method optional so
deterministic doubles are unaffected). Deterministic ordering test asserts
interrupt-before-close. Honest deviation (recorded in the handoff):
termination is child-scoped, not process-group-scoped — the pinned spawn is
not detached, so the app-server's own children rely on its SIGTERM handling.

### F-8 — Verified first, then implemented as real-burst-v2 (acceptance-sensitive)

Verification before any change, from the durable per-burst usage rows still
on disk in the final-E2E canary state database:

- The six rows sum to exactly the recorded total 389,629 and reproduce the
  recorded by-provider byProvider split.
- The v1 per-stage framing constants match the reviewer's byte-for-byte
  (opening 599, candidate 943, review 847, signoff 590; Σ over the six-burst
  shape = 4,168) and reproduce `1.010813026479981` exactly.
- Reviewer correction: the "goal charged twice more ⇒ 1.0160" check used a
  975-byte Goal Packet estimate; the durably recorded Goal Packet is
  **1,045 bytes**, giving **1.0163**. Direction and conclusion verified;
  exact figure corrected.

Change: `realBurstAttribution(stage, duplicatedRestatements)` bumped to
`real-burst-v2`. The runner passes the coordinator-composed duplicate
restatements it actually sends: the Goal Packet re-stated into the resumed
candidate and review sessions, Codex's own opening re-sent to it at
candidate, the manifest re-sent to its own author (Claude) at signoff, and
the composed digest lines at both signoffs. Peer content (Claude opening to
Codex, candidate to Claude, exact reviewed manifest to Codex) is treated as
useful first transmission. `C_upper` therefore grows with coordinator
content actually composed; a fixture asserts the growth.

Re-verification of the recorded final trace under v2 (durable rows + durably
recorded payloads): `C_upper` 15,426 bytes → ratio **1.0412236139207862**,
still ≤ 1.05, pinned as an exact regression
(`test/real-overhead-attribution.test.ts` +
`test/fixtures/v13-final-e2e-recorded.json`). The recorded V-13 artifacts
remain v1 measurements and were not touched; their authorizations are
consumed, so re-measuring is impossible. Caveat: the Codex-opening duplicate
in the recomputation is reconstructed from the durable packet exactly as
`openingValue()` reconstructs it on resume; if the live model emitted fields
beyond `{rationale, evidence, risks}`, the live prompt was marginally larger
than the recomputed charge. Margin to the gate is 3,383 charged bytes.

### F-9 — Fixed via the restrict option

`policy.ts` requires exactly `authMethod === "claude.ai"` (plan §5.1.4);
`claude-adapter.ts` sources `authMethod` solely from
`claude auth status --json` (the `account.tokenSource` fallback the review
flagged is removed). The alternative branch (pin "oauth") was rejected for
lack of primary evidence: this machine's evidence records `claude.ai` when
logged in and `none` when logged out, and no pinned-runtime source shows
"oauth". A fixture asserts "oauth" fails closed; the cost of being wrong is
a fail-closed block with a Retry preflight card, which is the product's
stated posture.

### F-10 — Fixed (secondary rate-limit window)

`codex-client.ts` extracts `secondary` exactly like `primary`
(absent/null vs present distinguished). `policy.ts`: a present-but-malformed
secondary blocks as `codex.billing_route_unproven`; either window ≥ 100% or
a non-null `rateLimitReachedType` triggers the existing-credits branch
(still requiring `credits.hasCredits === true`, else the no-credits block);
proof lines carry both windows ("secondary window absent in provider
response" when null). Fixture matrix: both-low, secondary-saturated with and
without credits, malformed, absent.

### F-11 — Partial; remainder deferred plainly

Implemented: real budget controls in the advanced drawer (`perProvider`,
`perMaterialChallenge`) wired through `CreateRunInput` into the Goal Packet
and enforced budgets; run export wired end-to-end —
`POST /api/runs/:id/export` → `@collab/migration` `exportRun` (canonical
JSONL + transcript + projection with checksums under the service state
directory) with an "Export run" button on completed runs.

Deferred, stated in the handoff: permission-preset control (nothing
downstream honors a non-default preset yet, so a control would be
dishonest), attachments, stop conditions, and the read-only legacy
task-folder browser (legacy read/import remains a V-10-covered library,
unreachable from service/UI). These remain approved-plan MVP surface this
build does not deliver.

### F-12 — Fixed

`app.tsx` renders `manifest.evidenceLedger` between artifacts and the
verification ledger, with an explicit empty state.

## Judgment calls a verifier should challenge

1. **F-8 duplicate-restatement set.** Which payloads count as coordinator
   duplication vs useful first transmission (notably: exact reviewed
   manifest to Codex at signoff treated as useful; peer opening to Codex
   treated as useful). The plan §8 counterfactual is the standard.
2. **F-8 arithmetic.** 15,426 / 1.0412236139207862 recomputed from the
   durable rows; the 1,045-byte Goal Packet measurement vs the review's 975.
3. **F-9 decision.** Restrict-to-`claude.ai` chosen over pinning "oauth".
   Primary evidence that the pinned runtime emits "oauth" for subscription
   login would reverse this.
4. **F-6 grandfather safety.** Only the two exact digests pass claim-less;
   confirm no other claim-less artifact can validate.
5. **F-3 semantics.** "Supply information or authority" = audited override +
   extension + resume; "Decide" = audited user decision →
   `completed_disagreement`. Both are interpretations of plan §3.8/§1.6.
6. **F-5 strength.** `nestedUsageComplete` derives from "usage reported and
   non-zero" — deliberately weaker than a tree-coverage proof (documented).
7. **F-7 scope.** Child-scoped SIGTERM→SIGKILL, not process-group.
8. **Test-expectation changes.** V-9 now asserts the simulated markers; V-11
   waits for the demo chip; the six-burst integration fixture's engineered
   volumes rose 20,000 → 40,000 input tokens/burst because v2 charges
   duplicate bytes and tiny engineered traces would sit near the 1.05 gate
   by construction. Challenge these if they look like test-gaming; the
   recorded real trace is the load-bearing regression.

## Independent re-derivation hooks

- The final-E2E durable state database still exists at the `canaryRoot`
  recorded inside `artifacts/v13-collab-e2e.json`
  (`.../collab-canary-collab-e2e-MdOi8j/state/events.sqlite`). Copy it
  before querying (WAL). `usage_records` holds the six rows;
  `goal_set`/`packet_posted`/`candidate_posted` events hold the payloads
  from which `test/fixtures/v13-final-e2e-recorded.json` was extracted.
- The v1 framing constants are recomputable as
  `Buffer.byteLength(canonicalJson(realBurstAttribution(stage).coordinatorOwnedContent))`
  minus the v2 `duplicatedRestatements: []` field bytes (28/stage).

## Verification observed (2026-07-26, after all changes)

- `npm run verify:pins` → V-0 pass, pins unchanged, modelStarts 0.
- `npm run build` → strict TypeScript + Vite pass.
- `npm test` → 24 files / 89 tests pass; every suite prints modelStarts 0;
  V-11 browser harness re-passed on the new UI.
- `npm run verify:zero-call` → pass; still exactly 1 guarded Codex turn
  site, 1 guarded Claude model-query site, 1 metadata-only query, 0
  forbidden billing calls.
- `env -u ANTHROPIC_BASE_URL npm run verify:all -- --v12-result
  artifacts/v12-30m.json --v13-smoke-result artifacts/v13-smoke.json
  --v13-e2e-result artifacts/v13-collab-e2e.json --json-out
  /private/tmp/codex-remediation-acceptance.json` → 19/19 pass,
  `v13Status: passed` (smoke via recorded grandfather),
  `releaseReady: true`, modelStarts 10 (pre-recorded evidence only); doctor
  metadata-only, both providers ready on `subscription_allowance`.
- Zero provider model calls initiated; `pgrep` found no `codex app-server`
  or bundled-CLI processes; all new tests use deterministic ports.

## Tripwires re-verified byte-identical after all work

```
dcdee33eba3a75faafc125fdb9ba856e52475505ef4c7e48a2f4f372c9e8b943  final-plan.md
1f4b96d594d50c238b306a367bca53ee28318928cdfd813869f7cad49516e5a0  verification.md
8fc9a583680a6b6130a30461ac90c7196a6982133c3cc325442f016d93c0789f  package-lock.json
81c365a2738d212f3028c164815e37e573957d3d2ee4d9b9ff5fabb88bfad323  collab-acceptance.json
5eef0b6bb6e0e06eebaccb170369642a9c72f03fd073ec10120a246f08e1c6bd  v12-30m.json
10386ce3ac09624e5cbbd804548d58d159d4c17dccbd60af93edf6220fb8b2c9  v13-smoke.json
909d4ec52e0d91a6f5207d5baba925991bdd610f02c12488e37205b8b4ae4d77  v13-collab-e2e-attempt-1.json
869a1f640d928cbe9b8dc9234d5f58bc6fd14ec79e33595a045feec3a8676473  v13-collab-e2e.json
```

`artifacts/collab-acceptance.json` was NOT regenerated; the remediation
aggregate lives at `/private/tmp/codex-remediation-acceptance.json`.

## Files changed in this remediation

Source: `packages/contracts/src/index.ts`, `packages/kernel/src/queue.ts`,
`packages/kernel/src/store.ts`, `packages/adapters/src/policy.ts`,
`packages/adapters/src/codex-client.ts`,
`packages/adapters/src/claude-adapter.ts`,
`packages/service/src/real-runner.ts`, `packages/service/src/coordinator.ts`,
`packages/service/src/server.ts`, `packages/service/src/canary-evidence.ts`,
`packages/ui/src/app.tsx`, `packages/ui/src/styles.css`.
Tests: `packages/adapters/test/preflight.test.ts`,
`packages/service/test/canary-evidence.test.ts`,
`packages/service/test/real-overhead-attribution.test.ts`,
`packages/service/test/real-runner.integration.test.ts`,
`packages/security/test/security.test.ts`, `packages/ui/test/a11y.ts`.
New: `packages/service/test/real-runner-causality.test.ts`,
`packages/service/test/fixtures/v13-final-e2e-recorded.json`.
Docs: `docs/implementation-handoff.md` (Post-review remediation section),
this report.

---

## Third pass (2026-07-26): review of Codex's re-verification

Codex's adversarial pass (`docs/codex-verification.md`) was itself reviewed
file-by-file and its battery re-run independently. Verdict:

**Endorsed.** All five of Codex's additional repairs are real defect fixes,
not churn: the F-2 SSE/create upsert race, the F-3 structured-details channel
(closing the "no input surface" limitation this report had documented), the
F-5 trigger/reason binding (closing a genuine claim-reuse forgery my
derivation missed), the F-6 strict claim schema, and the F-7 process-group +
confirmed-exit + settle-before-terminalize contract (closing the child-scope
deviation this report had documented). Codex's independent F-8 recomputation
from its own quiescent DB copy matches this report's numbers exactly
(v1 4,168 / 1.010813026479981; v2 15,426 / 1.0412236139207862; goal packet
1,045 bytes). The `releaseReady=false` downgrade via the explicit
`mvpSurface` blocker is the more honest reading of plan §12 — release gates
were never only about test validity — and is endorsed; note the gap list is
a hand-maintained constant that must be updated when the F-11 surfaces ship.

**Two defects found in Codex's pass, both fixed and regression-tested:**

1. `close()` may now throw `CODEX_PROCESS_EXIT_UNCONFIRMED`, and `run()`'s
   cleanup propagates it — but `runReal` is invoked fire-and-forget with no
   catch, so a stuck child would have crashed the entire service via an
   unhandled rejection. `runReal` now contains cleanup failures and raises a
   durable "Provider shutdown did not confirm cleanly" card.
2. The shipped uncertain-effect cards offer "Cancel", which Codex's
   preserve-reconciliation guard had turned into a silent no-op (the F-3
   dead-end class; Codex's own test avoided it by using a card without a
   Cancel action). Cancel on the reconciliation card itself is now an
   audited `human_override` acknowledgment followed by `cancelled`; Cancel
   from other cards while reconciliation is pending still preserves the card.

Final state after the third pass: build pass; 99 Vitest tests + V-11 pass
with `modelStarts: 0` everywhere; zero-call audit unchanged (1/1/1/0);
aggregate 19/19, `v13Status: passed`, `releaseReady: false`
(`/private/tmp/claude-pass3-acceptance.json`); all eight tripwire hashes
byte-identical; zero provider model calls across all three passes.
