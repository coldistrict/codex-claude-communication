# Independent adversarial review — collaboration product

Reviewer: Claude (fresh session, no prior conversation context)
Date: 2026-07-26 (initial pass and second adversarial pass)
Scope: `product/` against `tasks/2026-07-25-collaboration-product-blueprint/final-plan.md`
(`collab-product-v3`), `verification.md`, the task evidence, `docs/implementation-handoff.md`,
and the authoritative 2026-07-26 billing-policy update.

## 1. Verdict

**The safety envelope holds. The product surface does not yet meet the approved plan, and
several plan invariants are asserted rather than measured.**

Every claim I could independently check about billing, zero-call enforcement, causality,
consensus integrity, and evidence tamper-resistance survived adversarial testing. All three
tripwire hashes and all five acceptance-artifact hashes match byte-for-byte. V-0 through V-12
and V-14 pass on this machine, the recorded V-13 evidence validates against independently
recomputed digests, and I confirmed by process inspection that nothing I did initiated a single
provider model call.

Eleven actionable defects remain, none of them critical-severity security issues. Two (F-1, F-2)
are provable correctness/usability failures a user would hit in ordinary operation — one of them
in this very repository. Two more, found on the second pass, matter for how much the acceptance
evidence actually proves: the overhead classifier's integrity flags are hardcoded rather than
derived (F-5), and `C_upper` is a constant that does not vary with real coordination cost (F-8).
`releaseReady=true` is justified for the billing and zero-model-call guarantees; it is **not**
justified as a statement that the approved personal-alpha MVP is complete. See §8.

I found no false-success path into consensus, no route by which untrusted content can alter the
goal, permissions, billing route, or tool policy, and no code path that can purchase, top up, add,
or reset credits.

## 2. Commands actually run and observed results

Dependencies were already present (`node_modules/`, `@anthropic-ai/claude-agent-sdk@0.3.220`,
`.playwright/`), so `npm ci` was not run, per instruction.

| Command | Observed result |
|---|---|
| `shasum -a 256` on both approved records + `package-lock.json` | All three match the supplied tripwires exactly |
| `shasum -a 256 artifacts/*.json` | All five match the expected values exactly |
| `node --version` / `npm --version` | `v22.22.2` / `10.9.7` (matches pin manifest `nodeMajor: 22`) |
| `npm run verify:pins` (V-0) | pass; canonical Codex schema `b5719e63…6947c`, 97 feature lines, SDK `0.3.220`, bundled CLI `2.1.220` / `8addc857…be081`, `modelStarts: 0` |
| `npm run build` | strict TypeScript + Vite build pass |
| `npm test` (V-1…V-11 + service) | 23 test files, 79 tests, all pass; every suite prints `modelStarts: 0`; V-11 axe harness: 0 serious/critical, keyboard complete, 1 live region, 0 reflow overflow, 115.86 ms render, 0 SSE duplicates, restart restored |
| `npm run verify:zero-call` | pass; 1 guarded Codex turn site, 1 guarded Claude model-query site, 1 metadata-only Claude query, 0 forbidden billing calls |
| `npm run verify:all -- --v12-result … --v13-smoke-result … --v13-e2e-result … --json-out /private/tmp/claude-review-acceptance.json` | 19/19 suites pass, `v13Status: passed`, `passed: true`, `modelStarts: 10` (pre-recorded evidence only), `releaseReady: false` — see §2.1 |
| `npm run doctor` (reviewer shell) | Both providers **blocked**: `codex.forbidden_environment:ANTHROPIC_BASE_URL`, `claude.forbidden_auth_route:ANTHROPIC_BASE_URL` |
| `env -u ANTHROPIC_BASE_URL npm run doctor` | Codex ready, ChatGPT `plus`, `subscription_allowance`, `usedPercent=76`, `credits.hasCredits=true`; Claude ready, `max`, `claude.ai`, `subscription_allowance`, `extraUsageEnabled=false`; `realProviderReady=true`; purchases/top-ups/reset-credits all 0 |
| Independent `validateCanaryEvidence` + digest recomputation over all three V-13 artifacts | All three valid, zero errors, recomputed digests equal the recorded ones |
| Tamper probe (flip `result.overhead.ratio` in the final E2E) | Rejected: `["evidence:digest"]` |
| Scope-confusion probe (smoke evidence validated as E2E) | Rejected with 12 errors including `evidence:suite`, `authorization:scope` |
| Model-start gate probes (turn/burst without preflight; run-ID mismatch; forbidden billing method) | All four blocked: `CODEX_PREFLIGHT_REQUIRED`, `CLAUDE_PREFLIGHT_REQUIRED`, `MODEL_START_BLOCKED`, `FORBIDDEN_BILLING_METHOD`; guard counters `started: 0` in every case |
| Live service (`npm start`, isolated `COLLAB_STATE_DIR` under `/private/tmp`), browser workflow | See §2.2 |
| Terminal-state probe (append after completion) | `TERMINAL_RUN` rejection; hash chain still valid at 33 events |
| Budget-exhaustion probe (`perProvider: 1`) | Dead-end card — finding F-3 |
| Failure-attribution probe (Codex error carrying a path containing "claude") | Misattributed to Claude — finding F-1 |
| **Second pass:** pinned-schema inspection for `RateLimitSnapshot` windows | Both `primary` and `secondary` defined; adapter extracts only `primary` — finding F-10 |
| **Second pass:** metadata-only `account/rateLimits/read` (no `thread/start`, no `turn/start`) | `secondary` present in response but null on this account; `primary.usedPercent=76`, no reached type, credits present — F-10 latent here |
| **Second pass:** caller search for `turn/interrupt` | Zero callers; `cancel()` SIGTERMs the app-server — finding F-7 |
| **Second pass:** overhead recomputation and sensitivity analysis | `C_upper` is a constant 4,168 B for this stage shape; 75.7% of the denominator is cache reads; 14,386 B of headroom to 1.05; stricter attribution gives 1.0160 — finding F-8 |

### 2.1 The aggregate correctly refused `releaseReady` in a dirty environment

My `verify:all` run reported `releaseReady: false` while the recorded
`artifacts/collab-acceptance.json` reports `true`. This is **not** a discrepancy in the artifact —
it is the fail-closed gate working. My reviewer shell exports `ANTHROPIC_BASE_URL`, and both
preflights blocked on it (`codex.forbidden_environment`, `claude.forbidden_auth_route`), which
drove `realProviderReady=false` and therefore `releaseReady=false`. With that one variable
removed, the doctor reproduces the recorded ready state on both providers. The custom-base-URL
prohibition in the authoritative policy is enforced in practice, not just in fixtures.

### 2.2 Live product exercise (fake/deterministic adapters only)

I ran `collabd` on loopback with an isolated state directory and drove it from a browser and
from `curl`. Exercised and confirmed: goal presentation (immutable goal heading), two independent
provider lanes with per-provider billing chips, opening barrier ("Released" only after both
openings), public packets with provenance, candidate manifest with artifacts, verification
ledger, known limitations and both exact digests, signoff and consensus, action cards, the
disagreement view, live overhead chip (`1.0471×`), degraded-mode banner wiring, reload, SSE
reconnect, service restart with restored history, keyboard navigation, focus visibility, live
region, and 375 px reflow.

- Security probes: unauthenticated `/api/runs` → 403; unauthenticated `/api/events` (SSE) → 403;
  wrong-Origin `/bootstrap` → 403; spoofed `Host` → 403; capability replay after exchange → 403;
  mutating POST without `X-Collab-CSRF` → 403; `/assets/../../../../etc/passwd` → 404; CSP is
  restrictive with no remote subresources; the public shell contains no run data and no
  capability; `history.replaceState` removed the fragment (verified `window.location.hash === ""`
  and `document.cookie === ""`, i.e. the session cookie is HttpOnly).
- SSE: one `ready` frame plus one `projection` frame per commit, zero duplicate payloads.
- Full collaboration driven through deterministic ports reached `completed_consensus` with a
  valid 32-event hash chain, 6 usage records, and overhead `1.0349` — matching the shape of the
  recorded real trace.
- Disagreement run (Codex declines, Claude signs) correctly terminated as `waiting_user` with a
  card retaining **both** positions and the actions `Accept disagreement / Extend budget /
  Cancel`; activating it produced `completed_disagreement` with packets, candidate and the single
  signoff retained. No consensus was manufactured.
- Accessibility: `main`/`header`/`aside`/labelled `section` landmarks, ordered `h1`→`h3`, exactly
  one `role="status" aria-live="polite"` region announcing meaningful state changes, all controls
  in a sensible tab order, 3 px focus outline (`styles.css:36`), and at 375 px the lanes collapse
  to a single column with `scrollWidth === innerWidth` and zero overflowing elements.

## 3. Confirmation that no product provider model calls were initiated

**Zero product provider model calls occurred during this review.** Evidence:

1. Every deterministic suite prints `modelStarts: 0`; the V-14 aggregate's only non-zero
   `modelStarts` (10) is the sum read out of the two **pre-recorded** V-13 evidence files
   (4 smoke + 6 E2E), not new activity.
2. `tools/run-all.ts` contains no canary invocation of any kind — it imports only
   `summarizeV13Evidence` and reads evidence files from disk. It cannot authorize or initiate
   V-13. I verified this by reading the command list (`tools/run-all.ts:38-62`) and by grep.
3. All three authorization files carry `.consumed` markers (mode 0600) and their `expiresAt`
   windows lapsed hours ago, so replay fails on two independent grounds.
4. Process inspection throughout the live UI session: `pgrep -P <collabd>` returned **0**
   children, `pgrep -f 'codex app-server'` → 0, `pgrep -f 'claude-agent-sdk-darwin-arm64/claude'`
   → 0. The provider SDKs are lazy-loaded and were never reached.
5. All browser/UI work used `mode: "fake"` or injected deterministic `RealCodexPort` /
   `RealClaudePort` test doubles. The real adapters were only ever invoked for
   **metadata-only** preflight (`account/read`, `account/rateLimits/read`, `config/read`,
   `claude auth status --json`, and the SDK's non-model `accountInfo()`/usage control call),
   which is what `npm run doctor` and V-0 do by design.
6. I did not run V-13, did not create an authorization file, did not touch the consumed ones,
   did not change authentication or billing configuration, and installed nothing.

## 4. Findings in priority order

### F-1 — Provider attribution by substring match durably misroutes limit/pause state

- **Severity:** Medium-High (correctness; durable false record; wrong user guidance)
- **File/line:** [`packages/service/src/real-runner.ts:1403`](../packages/service/src/real-runner.ts#L1403)

```ts
const provider: ProviderRole = message.toUpperCase().includes("CLAUDE")
  ? "claude"
  : "codex";
```

- **Evidence / reproduction:** I drove `RealCollaborationRunner.run()` with a Codex port that
  throws a realistic `CODEX_APP_SERVER_EXIT:1:null:usage limit reached while running in
  <workspace>` where the workspace path contains the substring `claude` — the exact shape of this
  repository (`codex-claude-communication`). Observed result:

  ```json
  {"failingProvider":"codex",
   "pausedLimitEvents":[{"attributedRole":"claude","cardTitle":"claude paused on a provider limit","cardAgent":"claude","resetsAt":null}],
   "workerStates":{"claude":"paused_limit_unknown","codex":"working"}}
  ```

  The real `CodexAppServerClient` embeds the child's stderr tail in exactly this error string
  (`codex-client.ts:94-96`), and the adapter's `cwd` is always the task workspace, so the
  workspace path routinely appears in Codex failure text.
- **End-user impact:** The dashboard tells the user Claude hit a provider limit when Codex did.
  The healthy provider is parked as `paused_limit_unknown` while the genuinely failed one is left
  displayed as `working`, so the state line is wrong on both lanes at once. The recovery
  instructions point at the wrong account, and the misattribution is written permanently into the
  hash-chained event log, so the exported audit trail is wrong too. Anyone running the product
  against this repository is exposed.
- **Required correction:** Carry the failing provider explicitly. `executeProviderBurst` already
  knows the `role`; propagate it (e.g. wrap the burst error in a typed error carrying `role`, or
  pass the role into `recordFailure`) and delete the message-substring inference. The same applies
  to the context-exhaustion branch at `real-runner.ts:1428-1436`, which reuses the same wrong
  `provider` value.

### F-2 — The dashboard can display only one run; a run awaiting the user's decision is unreachable

- **Severity:** Medium-High (contradicts plan §1.7 and the brief's core routing promise)
- **File/line:** [`packages/ui/src/app.tsx:136`](../packages/ui/src/app.tsx#L136) and
  [`packages/ui/src/app.tsx:149`](../packages/ui/src/app.tsx#L149)

```ts
const selected = useMemo(
  () => runs.find((run) => run.runId === selectedRunId) ?? runs.at(0) ?? null, …);
…
setSelectedRunId((current) => current ?? next.at(0)?.runId ?? null);
```

- **Evidence / reproduction:** With three runs in one store — one `starting`, one
  `completed_consensus`, one `waiting_user` holding a pending disagreement card — I loaded the
  dashboard and queried the live DOM plus `/api/runs`:

  ```json
  {"runsInStore":3,
   "runIdsInApiOrder":["run_49419bb3-123 [starting]","run_542663a5-493 [completed_consensus]","run_fad96a39-98c [waiting_user]"],
   "displayedGoal":"Review the demo workspace and produce a one-paragraph summary both providers co-sign.",
   "displayedState":"starting","actionCardsShown":0,"anyRunSwitcherControl":0}
  ```

  `setSelectedRunId` is only ever called on first load and on run creation; `grep` finds no run
  list, `<select>`, tab list, or per-run click handler anywhere in the UI. `/api/runs` orders by
  `run_id` (`kernel/src/store.ts:159`), which is a random UUID, so which single run is reachable
  after a reload is effectively arbitrary.
- **End-user impact:** After the first collaboration, every later run is invisible. A run that is
  blocked on a human decision — disagreement, permission, uncertain effect, unknown-duration
  limit — shows "Action needed (0)" and can never be answered from the UI, which defeats the
  product's central promise of routing honest disagreement to the user. Completed outcomes,
  manifests, and sign-offs become unreachable, contradicting plan §1.7 ("run list persists;
  completed runs are read-only") and the brief's close-the-view-and-return requirement.
- **Required correction:** Add a run list/switcher (with state and pending-action count per run)
  and order `/api/runs` by recency rather than by `run_id`. Prefer selecting a run that has
  pending action cards.

### F-3 — Budget exhaustion yields a dead-end failure card instead of plan §3.8's five actions

- **Severity:** Medium (documented recovery path is unreachable; low practical reachability today)
- **File/line:** [`packages/service/src/real-runner.ts:1437`](../packages/service/src/real-runner.ts#L1437)
  (generic card) receiving the kernel throw from
  [`packages/kernel/src/store.ts:443`](../packages/kernel/src/store.ts#L443)
- **Evidence / reproduction:** I created a run with `budgets: { perProvider: 1 }` so the opening
  burst consumes the only unit, then let the runner proceed to the candidate stage:

  ```json
  {"state":"waiting_user","budgets":{"claude":{"consumed":1,"limit":1},"codex":{"consumed":1,"limit":1}},
   "actionCards":[{"kind":"needs_input","title":"Collaboration paused after a provider failure",
                   "actions":["Retry collaboration","Cancel"],"body":"Useful-work burst budget is exhausted"}]}
  ```

  Plan §3.8 requires exhaustion to enter `waiting_user` "showing consumed/remaining counts, both
  evidence positions, and the exact actions (extend / supply information or authority / decide /
  accept-documented-disagreement / cancel)". The card shows none of the counts, neither position,
  and 2 of the 5 actions. `Extend budget` *is* implemented in `coordinator.decideAction`
  (`coordinator.ts:169-181`) but is never offered here, and `Retry collaboration` re-enters
  `claimModelWork` → the same `BUDGET_EXHAUSTED` throw, so it is an infinite loop. Cancel is the
  only real exit.
- **End-user impact:** A user who lowers budgets loses the run with no path forward other than
  cancelling, and is told a provider failed when none did. The mislabelling also pollutes the
  audit log with a spurious "provider failure".
- **Required correction:** Catch `KernelError` with code `BUDGET_EXHAUSTED` in the runner and emit
  a dedicated budget card carrying consumed/remaining per provider and per issue, both recorded
  positions, and all five plan actions. Mitigating context: at the default `perProvider: 24` the
  linear flow claims only 3 bursts per provider, and the UI exposes no budget control, so this is
  reachable today only through a direct API override.

### F-4 — Demo runs and the `fixture` endpoint write fabricated billing proof that the UI renders as a proven route

- **Severity:** Medium (durable-state and UI accuracy; **cannot** cause a model start — verified)
- **File/line:** [`packages/service/src/coordinator.ts:219`](../packages/service/src/coordinator.ts#L219)
  (`retryPreflight` hardcoded fixtures), called unconditionally by `runDeterministicDemo`
  ([`coordinator.ts:312`](../packages/service/src/coordinator.ts#L312)); reachable from the
  authenticated production API at
  [`packages/service/src/server.ts:249`](../packages/service/src/server.ts#L249); server-side
  default mode is `fake` at [`coordinator.ts:107`](../packages/service/src/coordinator.ts#L107).
- **Evidence / reproduction:** I started a `mode: "fake"` run from the browser and dumped the
  durable events straight out of SQLite while `pgrep` confirmed **zero** provider processes had
  ever been spawned:

  ```
  preflight_passed actor=system provider=codex route=subscription_allowance plan=plus authBy=chatgpt
      proof: account/read type=chatgpt
      proof: paid plan=plus
      proof: primary.usedPercent=35
      proof: credits.hasCredits=true
  preflight_passed actor=system provider=claude route=subscription_allowance plan=max authBy=claude.ai
      proof: official SDK bundled CLI auth status loggedIn=true
      proof: authMethod=claude.ai
      …
      proof: existingCreditsRemaining=undefined
  ```

  The dashboard rendered "Subscription allowance" chips for both providers, visually identical to
  a genuinely proven route. Separately, `POST /api/runs/:id/retry-preflight` with
  `{"fixture":"blocked"}` returned 200 and flipped the durable record and the UI chip to "Billing
  blocked"; `{"fixture":"clean"}` flipped it back to a fabricated allowance. Note the leaked
  `existingCreditsRemaining=undefined` string, evidence these proof lines are synthesised rather
  than observed.
- **End-user impact:** Neither the durable billing record nor the UI chip distinguishes a real
  proven subscription route from a demo-fabricated one, which is precisely the distinction the
  authoritative policy requires the UI and durable state to make clear. A user reviewing history
  (or an auditor reading an export) cannot tell which billing claims were actually observed from
  a provider. `packages/security/test/security.test.ts:89-90` asserts the fabricated
  `subscription_allowance` value as expected behaviour, so the suite currently locks it in.
- **Mitigating factor I verified:** this cannot cause spend. The adapters gate model starts on
  their own in-memory `billing` field set only by a real `metadataPreflight`
  (`codex-client.ts:244`, `claude-adapter.ts:252`); they never consult the projection. My probes
  confirmed `CODEX_PREFLIGHT_REQUIRED` / `CLAUDE_PREFLIGHT_REQUIRED` with guard counters at
  `started: 0`.
- **Required correction:** Tag fixture-sourced billing status distinctly (e.g.
  `route: "unknown"` with an explicit `simulated: true` and a UI "Demo — not a proven route"
  chip), and gate the `fixture` request parameter behind an explicit development flag so it is
  not reachable from the shipped API. Update the V-9 assertion to expect the simulated label.

### F-5 — The overhead classifier's integrity flags are hardcoded, not derived from the causal record

- **Severity:** Medium (a plan §8 release invariant is asserted rather than measured on the
  production path — "a test that can pass while production wiring is defective")
- **File/line:** [`packages/service/src/real-runner.ts:1471`](../packages/service/src/real-runner.ts#L1471)

```ts
this.store.recordUsage(runId, `${role}:${burst}`, {
  provider: role,
  ...usage,
  ...attribution,
  attributionComplete: true,   // literal
  uncaused: false,             // literal
  nestedUsageComplete: true,   // literal
});
```

- **Evidence / reproduction:** `reportOverhead` derives three of its four gate predicates from
  these fields (`overhead.ts:46-58`): `uncausedInvocations` counts records with `uncaused`,
  and `coverageComplete` is falsified by `nestedUsageComplete: false` or by an unattributed
  `useful` record. On the real path all three are written as literals, never read back from the
  ready-queue claim that preceded the burst. Consequently `uncausedInvocations` is structurally
  incapable of being non-zero and `coverageComplete` incapable of being false in any real run,
  including the recorded V-13 E2E — whose `"uncausedInvocations": 0` and
  `"coverageComplete": true` are therefore restatements of these constants, not measurements.
  The corresponding V-7 fixtures pass only because the test constructs records with the flags set
  by hand (`kernel/test/overhead.test.ts:28-45`).
- **End-user impact:** The plan §8 invariant "zero model invocations whose trigger cannot be
  traced to a new addressed event, user action, trusted structured timer, or recovery obligation"
  is enforced by construction in the current happy path — I verified every burst call site in
  `collaborate()` is preceded by `claimModelWork` — but it is not *verified* anywhere in the
  classifier. Any future burst site added without a preceding claim would still self-report as
  caused, and the overhead gate would pass while silently violating the invariant.
- **Mitigating factor:** `tools/canary.ts` does perform an independent cross-check for V-13
  evidence (`usageCoverageComplete = usage.length === modelStarts`,
  `noOpInvocations = modelStarts - usage.length`, and `wakeLatency.sampleCount === modelStarts`),
  and `validateCanaryEvidence` requires those to hold. So the recorded E2E *is* independently
  corroborated. Ordinary user runs get no such cross-check.
- **Required correction:** Derive the flags. `claimModelWork` already returns the claiming event
  with `readyWorkId`/`triggerEventId`; thread that through to `recordUsage` and set
  `uncaused: true` when no ready-work record backs the burst. Add a V-7 fixture in which a burst
  is executed without a claim and assert the gate fails.

### F-6 — The evidence validator does not require the one-use authorization claim, and two of three accepted artifacts lack it

- **Severity:** Low-Medium (tamper-evidence completeness; honestly disclosed in the handoff)
- **File/line:** [`packages/service/src/canary-evidence.ts:136`](../packages/service/src/canary-evidence.ts#L136)
  (`validateCanaryEvidence` checks digests, scope, timestamps and hard predicates but never
  inspects `result.authorizationClaim`)
- **Evidence / reproduction:**

  ```
  v13-smoke.json:                observedAt=2026-07-26T15:29:10.969Z  claimPresent=False
  v13-collab-e2e-attempt-1.json: observedAt=2026-07-26T15:35:45.770Z  claimPresent=False
  v13-collab-e2e.json:           observedAt=2026-07-26T16:21:00.211Z  claimPresent=True  claimedAt=2026-07-26T16:16:04.228Z (before the run)
  marker …smoke….consumed: mtime=2026-07-26T15:42:20Z
  marker …e2e-20260726.json.consumed: mtime=2026-07-26T15:42:20Z
  marker …e2e-final….consumed: mtime=2026-07-26T16:16:04Z
  ```

  The two earlier markers post-date their runs by about seven minutes, confirming the handoff's
  own statement that "retroactive claim markers were installed for both already-used
  authorizations". Only the final E2E was genuinely claim-protected before metadata or model work.
  Both claim-less artifacts still validate as `valid: true`.
- **End-user impact:** Bounded and disclosed, but it means the "one-use authorization claimed
  before any model work" property is empirically proven for exactly one of the three real runs,
  and the validator cannot detect the difference on any future artifact either.
- **Required correction:** Make `result.authorizationClaim` a required field for
  `passed === true` evidence, assert `claimedAt < observedAt`, and treat its absence as an
  integrity error. The two historical artifacts should then be explicitly grandfathered in the
  handoff rather than silently accepted.

### F-7 — Cancellation never sends `turn/interrupt`; it SIGTERMs the app-server immediately

- **Severity:** Medium (deviates from the approved kill contract; weakens uncertain-effect
  reconciliation)
- **File/line:** [`packages/service/src/real-runner.ts:397`](../packages/service/src/real-runner.ts#L397)
  calling [`packages/adapters/src/codex-client.ts:313`](../packages/adapters/src/codex-client.ts#L313);
  the implemented `interrupt()` at
  [`codex-client.ts:309`](../packages/adapters/src/codex-client.ts#L309) has **zero callers**
- **Evidence / reproduction:** `grep -rn "interrupt" packages/adapters/src packages/service/src
  tools` returns exactly three hits: the `interrupt()` definition, its own `turn/interrupt`
  request line, and an unrelated `stream.interrupt()` in the Claude adapter's `apiKeySource`
  contradiction path. Nothing invokes the Codex interrupt. `cancel()` is:

  ```ts
  active.abortController.abort();
  await active.codex.close();   // → this.process.kill("SIGTERM")
  ```

  Plan §10 specifies "Codex `turn/interrupt` → grace → process-group terminate; force-kill only
  after grace, followed by the §7 reconciliation." There is no interrupt, no grace period, and no
  process-group termination.
- **End-user impact:** Cancelling a run kills the app-server mid-turn. The turn is not cleanly
  interrupted provider-side, so allowance may be consumed for work that is then discarded, and the
  child's own cleanup does not run. More importantly, a tool call that was already authorized and
  in flight is terminated abruptly, which is exactly the "uncertain side effect" case plan §4.1
  wants reconciled — the lease path handles this, but a clean interrupt would narrow the window
  substantially.
- **Required correction:** In `cancel()`, call `interrupt(threadId, turnId)` for the in-flight
  turn, wait a bounded grace period, then close; track the active `threadId`/`turnId` on the run
  (the runner already has both). Add a deterministic test asserting interrupt-before-terminate
  ordering.

### F-8 — `C_upper` is a constant independent of actual coordination cost, and the ratio is dominated by cache reads

- **Severity:** Low (measurement sensitivity; the verdict is robust — quantified below)
- **File/line:** [`packages/service/src/real-runner.ts:193`](../packages/service/src/real-runner.ts#L193)
  (`realBurstAttribution` returns fixed per-stage content) consumed by
  [`packages/kernel/src/overhead.ts:54`](../packages/kernel/src/overhead.ts#L54)
- **Evidence / reproduction:** `coordinatorOwnedContent` is a per-stage constant — the fixed
  instruction lines, payload *labels*, join separator and transport envelope. It does not include
  the content the coordinator actually composes into each prompt: the re-transmitted Goal Packet,
  the openings, the candidate, or the manifest. I measured the charge per stage:

  ```
  opening 599   candidate 943   review 847   signoff 590   (bytes)
  ```

  Summed over the six-burst shape this is **exactly 4,168 bytes for any run of this shape**,
  regardless of how much was actually transmitted — which is why both recorded E2E runs carry the
  identical `coordinationUpper: 4168` under the corrected labels despite differing in total usage
  by 29% (301,535 vs 389,629). Meanwhile cached input is **75.7%** of the final run's denominator
  (294,844 of 389,629), so `S_lower` is dominated by cache-read volume — the very place re-sent
  context accumulates. The net effect is that the ratio drifts toward 1.0 as a run grows, largely
  independent of coordination behaviour.
- **End-user impact:** The ≤1.05 gate is much less sensitive than plan §8's "conservative upper
  bound" framing suggests. It would not detect a regression that increased genuine coordinator-
  composed content, because that content is not charged.
- **Why the verdict is nonetheless robust — I quantified it:** `C_upper` would have to reach
  **18,554 bytes** to breach 1.05 on the final run, against the 4,168 actually charged — 14,386
  bytes of headroom, 4.45×. Charging the Goal Packet twice more (975 bytes each, for the
  `candidate` and `review` prompts sent into already-resumed sessions, which the approved
  counterfactual explicitly removes as "duplicate restatements") raises `C_upper` to 6,118 and the
  ratio to **1.0160** — still comfortably passing. So the recorded result survives a stricter and
  arguably more faithful attribution.
- **Required correction:** Include the coordinator-composed payload bytes actually sent (goal
  restatements into resumed sessions, and the manifest re-sent to its own author at signoff) in
  `coordinatorOwnedContent`, and add a V-7 fixture asserting `C_upper` grows when prompt-composed
  coordinator content grows. Consider reporting the ratio with and without cache reads, since
  plan §8 asks for cache effects to be reported per category.

### F-9 — The Claude auth predicate accepts `authMethod: "oauth"`, which the approved plan does not

- **Severity:** Low-Medium (defense-in-depth erosion against the exact approved predicate)
- **File/line:** [`packages/adapters/src/policy.ts:311`](../packages/adapters/src/policy.ts#L311)

```ts
!["claude.ai", "oauth"].includes(input.auth.authMethod) ||
```

- **Evidence / reproduction:** Plan §5.1.4 states the pre-start gate exactly as
  `loggedIn ∧ authMethod=="claude.ai" ∧ apiProvider=="firstParty"`. The implementation widens the
  accepted set to include the bare string `"oauth"`. The value is also not read from a single
  trusted field: `claude-adapter.ts:176` sources it as
  `String(auth.authMethod ?? account?.tokenSource ?? "unknown")`, so a `tokenSource` of `"oauth"`
  satisfies the predicate when `authMethod` is absent. The evidence file
  `artifacts/codex-local-evidence.md` records the real shape as `"authMethod":"none"` when logged
  out, and the live doctor reports `claude.ai` when logged in — so `"oauth"` is not a value this
  machine has been observed to produce, and no fixture exercises it.
- **End-user impact:** Not proven exploitable — `apiProvider === "firstParty"`, a paid
  `subscriptionType`, and `apiKeySource ∈ {none, subscription}` are all still required, and the
  environment scrub removes Console/API routes first. But the product's central promise is that
  the subscription predicate is exactly the one that was reviewed and approved, and this one is
  not. An undocumented OAuth flavour reaching `firstParty` would pass a gate the plan intended to
  reject.
- **Required correction:** Restrict to `authMethod === "claude.ai"` as approved, or, if the pinned
  runtime genuinely emits `"oauth"` for subscription login, record that primary evidence in the
  handoff, pin it, and add a fixture — do not widen silently.

### F-10 — The Codex `secondary` rate-limit window is parsed away and never evaluated

- **Severity:** Low (latent on this account; incomplete against the pinned schema)
- **File/line:** [`packages/adapters/src/codex-client.ts:143`](../packages/adapters/src/codex-client.ts#L143)
  (only `primary` is extracted) and
  [`packages/adapters/src/policy.ts:208`](../packages/adapters/src/policy.ts#L208)
  (route computed from `primary.usedPercent` alone)
- **Evidence / reproduction:** The pinned schema's `RateLimitSnapshot` defines **both** `primary`
  and `secondary` as `RateLimitWindow` (verified in all three generated schema files under
  `tasks/.../artifacts/codex-appserver-schema-stable/`). The adapter's `rateLimits` mapping builds
  `{ structurallyTrusted, planType, primary, credits, rateLimitReachedType, spendControlReached }`
  — `secondary` is dropped before the policy ever sees it. A metadata-only read against the live
  account (no `thread/start`, no `turn/start`) confirms the field is present in the response and
  currently null here:

  ```json
  {"primary":{"usedPercent":76,"windowDurationMins":10080,"resetsAtPresent":true},
   "secondary":null,"secondaryPresentInResponse":true,
   "rateLimitReachedType":null,"spendControlReached":false,"creditsPresent":true}
  ```

- **End-user impact:** Latent today, since this account populates only the weekly window. On an
  account where the secondary window is populated, a saturated secondary would not affect the
  computed route: the product would keep reporting `subscription_allowance` and rely entirely on
  `rateLimitReachedType` becoming non-null as a backstop. Given OpenAI's documented "included
  usage first, then credits" behaviour once a plan limit is hit, that is precisely the transition
  the route label exists to surface. The `structurallyTrusted` completeness check also never
  validates the secondary window's shape, and the UI cannot show the user how close the other
  window is.
- **Required correction:** Extract `secondary`, require both present windows to be structurally
  complete, and treat *either* window at 100% as the trigger for the existing-credits branch.
  Surface both windows in the billing chip's proof lines.

### F-11 — Advanced settings is inert; legacy history and export are implemented but unreachable

- **Severity:** Low (plan §1.7, §3.8, §11 surface completeness)
- **File/line:** [`packages/ui/src/app.tsx:298`](../packages/ui/src/app.tsx#L298) (drawer is
  static prose); `@collab/migration` is imported by no file under `packages/service/src/` or
  `packages/ui/src/`
- **Evidence / reproduction:** The "Advanced settings" `<details>` contains two explanatory
  paragraphs and no controls — no attachments, permission preset, stop conditions, resource mode,
  or the per-run budget override that plan §3.8 states is "overridable per run in the advanced
  drawer". Separately, `grep -rn "legacy\|@collab/migration\|exportRun" packages/service/src
  packages/ui/src` returns nothing: V-10 passes against the library directly, but no HTTP route or
  UI affordance exposes read-only legacy task folders (plan §1.7, §11) or `collab export`.
- **End-user impact:** Users cannot adjust budgets or permissions from the product, cannot browse
  their historical v1/v2 task folders, and cannot export a run without writing their own script —
  all of which the approved plan lists as MVP behaviour. Combined with F-2 this makes the
  history/audit story substantially thinner than the handoff implies.
- **Required correction:** Either wire the migration package into the service (a read-only legacy
  list/detail route and an export action) and add real controls to the drawer, or amend the
  handoff to state plainly that these ship as libraries only and are deferred.

### F-12 — The outcome view omits the manifest evidence ledger

- **Severity:** Low
- **File/line:** [`packages/ui/src/app.tsx:367`](../packages/ui/src/app.tsx#L367) — the
  `manifest-details` block renders artifacts, verification ledger, known limitations and both
  digests, but never `manifest.evidenceLedger`
- **Evidence / reproduction:** I seeded a manifest whose `evidenceLedger` contained a marker
  string and confirmed from the live DOM that it appears nowhere in the outcome section
  (`evidenceLedgerRenderedInOutcome: false`), while artifacts and verification entries render
  correctly.
- **End-user impact:** Plan §3.5 makes the evidence ledger a first-class outcome-manifest field
  and §1.6 requires the completion page to present the evidence behind the result; users signing
  off on an outcome cannot see it without exporting the database.
- **Required correction:** Render `evidenceLedger` alongside the verification ledger.

  (Incidental positive from the same probe: the injected `<script>` payload in that ledger was
  never evaluated. There is no `dangerouslySetInnerHTML` or `innerHTML` anywhere in the UI, and
  Preact escapes all interpolated text; the page carries exactly one script tag, its own bundle.)

## 5. Areas audited that produced no actionable finding

These were examined adversarially and held up. I list them so the absence of a finding is not
mistaken for absence of scrutiny.

- **Billing policy conformance.** `evaluateCodexPreflight` routes to `subscription_allowance`
  while `usedPercent < 100` with no reached type, to `existing_credits` only after the included
  limit is exhausted *and* credits exist, and blocks otherwise; `credits.hasCredits === true` is
  correctly not a block (`policy.ts:221-237`). Claude requires `currentRoute` plus
  `includedUsageRemaining`, and only accepts `existing_credits` when extra usage is explicitly
  enabled, included usage is exhausted, and credits remain (`policy.ts:334-356`). Missing,
  malformed, or contradictory metadata fails closed in both. `parseClaudeBillingUsage` correctly
  ignores the `limits`/`spend` UI objects as utilization windows and returns `null` on any present
  but incomplete window. Credit balances are compared across refreshes without persisting the
  balance (`codex-client.ts:161-173`) — only a boolean "changed" flag reaches durable state.
- **Prohibited routes.** API-key, `apiKeyHelper`, Bedrock/Vertex/Foundry, custom base URLs and
  custom providers are scrubbed from the child environment, audited in the effective Codex config
  layers, and re-checked post-spawn (`modelProvider`, `apiKeySource` → immediate interrupt and
  `billing_integrity_unknown`). I confirmed the env scrub end-to-end in a real child process, and
  the reviewer-environment block in §2.1 is live proof.
- **No purchase/top-up/reset path.** `FORBIDDEN_CODEX_METHODS` is enforced at the JSON-RPC
  request boundary and throws before any write; the structural audit finds zero forbidden call
  sites; the doctor reports `creditPurchases: 0, automaticTopUpsEnabledByProduct: 0,
  resetCreditsConsumed: 0`.
- **Model-start causality.** The ready queue is SQLite-durable with a `UNIQUE(run_id, role,
  trigger_event_id, reason)` dedup, an atomic `BEGIN IMMEDIATE` claim, and a hard refusal to claim
  any zero-cost reason (`queue.ts:88-94`), which I confirmed throws. Every real claim records
  `readyWorkId`, `triggerEventId`, `wakeReason` and `wakeLatencyMs`; the integration test asserts
  6 wakes for 6 bursts with no orphans and an empty queue at the end. Retries and lease waits
  carry `chargeBudget: false` / `modelWake: false`, so waits cannot consume budget or launch models.
- **Opening barrier.** Enforced in the kernel, not in prompts: `barrier_released` requires both
  openings committed, and `packet_posted` before release is rejected unless it is that actor's own
  opening or a blocker (`store.ts:417-433`). The integration test asserts each provider's opening
  prompt contains none of the peer's text, and that peer content appears only in the post-barrier
  candidate/review prompts.
- **Consensus integrity.** Signoff requires the actor to sign for itself, exact manifest **and**
  verification digest equality, and zero open material challenges; `completed_consensus` re-checks
  that both signoffs carry identical digests; terminal runs reject all further events (verified
  live: `TERMINAL_RUN`). There is no coordinator-authored signoff path — `signoff` is
  provider-actor-only. Artifacts are re-hashed from disk and path-contained before the candidate
  is accepted (`real-runner.ts:963-982`).
- **Leases and uncertain effects.** Overlapping mutation targets serialize with a `lease_waiting`
  event and no additional model wake (verified in the production-path test); a burst that fails
  after acquiring a mutation lease keeps the lease, raises an `uncertain_effect` card, and is
  never replayed on restart — the coordinator converts outstanding leases and stale permission
  waits into non-replaying reconciliation cards at startup.
- **Prompt injection.** Untrusted openings, candidates, manifests and tool output are carried as
  data. The Goal Packet is immutable (`goal_set` is user-only and rejected if one exists, with a
  digest check); permissions are classified by the coordinator and decided only in the UI; billing
  comes solely from adapter metadata. No path lets provider or workspace text alter goal,
  authority, permissions, routing, or consensus rules. Provider text is redacted, depth/size
  bounded, and escaped before durable storage and rendering.
- **Security.** Loopback bind, one-time capability exchanged for a hashed durable session,
  HttpOnly+SameSite=Strict cookie, constant-time comparisons, strict Host/Origin/CSRF on every
  mutating route, session rotation, restrictive CSP, no remote subresources, path-traversal
  rejection, and a data-empty public shell — all verified live against the running service.
- **SQLite durability and migration.** WAL + `synchronous=FULL`, append-only hash chain verified
  end-to-end, idempotency keys with a conflicting-payload guard, projection rebuild on open,
  crash injection at three boundaries with projection-equals-replay, refusal of newer schemas and
  of migration-required older ones, quiesced-WAL enforcement, verified byte backup, transactional
  apply with rollback-and-restore, and zero mutations to historical task files.
- **Overhead classifier mechanics.** 1.04 passes and 1.06 fails to four decimals; unattributable
  mixed framing is charged in full; incomplete nested usage fails coverage; a record flagged
  uncaused fails the gate; the report is byte-deterministic. I recomputed the attempt-1 trace
  independently and reproduced `total 301,535` / ratio `2.8122755803434027` exactly under the old
  labels. (Two caveats on how much this proves are recorded as F-5 and F-8.)
- **The relabelling from "coordination" to "mixed" is justified.** Under the approved
  counterfactual (§8: "identical useful payloads; envelopes, duplicate restatements, no-op and
  recovery invocations removed"), the opening and signoff stages are genuine useful work — the
  openings are the independent investigation the barrier exists to protect, and signoff is the
  independent cross-check plan §3.4 mandates before consensus. Charging them entirely as
  coordination understated the denominator and produced the false 2.81 failure. I found no useful
  work improperly excluded and no double-counting: each of the six bursts contributes exactly one
  usage row keyed `role:burst`, and `usefulLower` is a pure subtraction from provider-reported
  totals. What remains charged is only the coordinator-owned framing — which is where F-8 applies:
  the relabelling is directionally right, but the residual charge is a constant rather than a
  measurement of the coordinator content actually sent. Charging the duplicated Goal Packet as
  well still passes (1.0160), so the corrected verdict holds under a stricter reading.
- **The preserved failed attempt is honest.** `v13-collab-e2e-attempt-1.json` validates,
  reports `passed: false` with the real 2.8123 ratio, and records that it nonetheless reached
  `completed_consensus` with the exact artifact — it is not quietly repaired or discarded, and
  `summarizeV13Evidence` correctly returns `failed` if any supplied evidence reports an observed
  failure.
- **Canary and acceptance integrity.** Evidence creation uses exclusive `wx` creation at mode
  0600; authorization claims use an exclusive 0600 `.consumed` marker; replay raises
  `REAL_CANARY_AUTHORIZATION_ALREADY_CONSUMED`; the validator enforces suite scope, authorization
  freshness (issued within 15 min, expiring within an hour) and a long list of hard predicates
  including exact start counts, attempts-equal-starts, wake coverage, credit-balance stability and
  Claude posture. My tamper and scope-confusion probes were both rejected. The failed first E2E
  attempt is preserved unmodified, validates, and honestly reports `passed: false` with the real
  2.8123 ratio — it is not quietly repaired, and V-14 correctly reports `failed` if any supplied
  evidence reports an observed failure.
- **Resource governor.** `memory_pressure -Q` free-percentage parsing maps <10% → red, <20% →
  yellow; degraded state stops admitting heavy work and serializes agents; the runner's
  `parallel()` honours `serializeAgents`; the recorded 30-minute soak shows 77.83 MiB service RSS,
  0.04% CPU, 9.42 ms max loop lag, zero swap growth and zero silent kills. I found no path where
  the governor kills in-flight work or wakes a model.

## 6. Verification steps skipped, with exact reasons

- **V-13 (`tools/canary.js --suite smoke` and `--suite collab-e2e`)** — not run. Explicitly
  prohibited by the review instructions; it consumes subscription allowance and initiates real
  provider model turns. I validated the recorded evidence and its tamper checks instead (§2, §4
  F-5).
- **Creating a real-canary authorization file** — not done. Explicitly prohibited, and it is the
  gate that would permit V-13.
- **Re-running the V-12 30-minute soak** — skipped; `verify:all` was given the recorded
  `artifacts/v12-30m.json`, which it independently revalidated (`suite === "V-12"`,
  `passed === true`, `minutes >= 30`, `modelStarts === 0`). Re-running would have added 30 minutes
  without testing anything the recorded artifact plus that validation does not already cover.
- **`npm ci`** — skipped per instruction because `node_modules/` was already present and complete;
  I verified the installed SDK version matches the pin manifest instead. This also avoided any
  risk of mutating `package-lock.json`, whose hash is a tripwire.
- **Git base-revision diff** — impossible. There is no `.git` directory or worktree pointer in the
  supplied workspace, exactly as `docs/implementation-handoff.md` records under "Scope and base
  revision" and "Deviations". **The handoff accurately records this deviation**, including the
  substitution of lockfile-hash stability for the lockfile-drift check. I reviewed `product/` as an
  additive implementation against the plan, verification spec, task evidence and handoff, as
  instructed.
- **Real permission-callback edge cases against live providers** — not exercised; that requires
  real model turns. Covered only by deterministic fixtures and the one recorded E2E.
- **Re-running the durable-billing-event dump combined with the raw-HTML-injection scan** — not
  repeated on the second pass, at the user's request (the tool call was flagged by a model
  safeguard). Nothing depends on repeating it: F-4 and F-12 already rest on the first pass's
  captured output, which is quoted verbatim in this document, and the absence of
  `dangerouslySetInnerHTML`/`innerHTML` in the UI was independently re-confirmed by reading
  `packages/ui/src/app.tsx` in full. No finding was added, removed, or changed as a result of
  skipping it.

## 7. Residual risks and unverified real-provider gates

1. **Bounded real-provider evidence.** The entire real-path claim rests on one smoke trace and two
   E2E traces from a single afternoon against one Codex alpha build and one pinned SDK. Provider
   response shapes, live permission callbacks, interruption mid-turn, session-resume edge cases,
   and limit/error varieties are almost entirely unexercised against reality.
2. **One-use authorization is empirically proven for one run only** (F-5). The smoke and first
   E2E were protected retroactively.
3. **Codex app-server is alpha and the Claude usage API is explicitly experimental** in the pinned
   SDK (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`). Both fail closed on drift,
   which is right, but any provider update can block the product until the pins and the policy are
   revalidated. `node:sqlite` is also still experimental in Node 22.
4. **The ≤1.05 result is less load-bearing than it looks.** Not because the margin is thin — it
   is not; `C_upper` has 4.45× headroom (F-8) — but because the quantity being bounded is a
   per-stage constant, while the denominator is 75.7% cache reads. The number is real and I
   reproduced it, but it should be read as "coordination framing is small relative to a
   cache-heavy run", not as a sensitive regression detector.
5. **The overhead denominator depends on a judgement call.** The `mixed` attribution is
   well-reasoned and I concur with it (§5), but "which stages count as useful work" is a
   classifier decision, not a measurement. A stricter reading that treats signoff as pure
   verification overhead would move the ratio materially. The classifier is versioned
   (`real-burst-v1`), which is the right mitigation.
9. **Two plan §8 invariants are self-certified on the production path** (F-5). "Zero uncaused
   invocations" and "complete usage coverage" hold by construction in the current code — I checked
   every burst call site — but nothing verifies them at runtime outside the canary tool. They are
   properties of the present control flow, not enforced invariants.
6. **Billing state is sampled, not continuous.** Preflight runs at start, before implementation and
   before signoff. A limit crossed mid-burst is caught only by the provider's own error, and the
   `subscription_allowance` → `existing_credits` transition is therefore visible at burst
   boundaries rather than at the moment it happens.
7. **Personal-alpha policy dependency.** Subscription-authenticated Agent SDK use rests on
   Anthropic's currently-paused credit program and the single-user reading of the OAuth terms.
   This is a documented standing watch item, not a defect, but it is an external dependency that
   can change without notice.
8. **Notifications.** Meaningful state changes are announced through one in-page live region and
   the action drawer; there is no OS-level notifier (`grep` finds no Notification API or
   `osascript` adapter). Plan §2 treats the macOS notifier as optional, so this is a scope note
   rather than a finding — but combined with F-2 it means a user who closes the tab has no
   mechanism at all that tells them a decision is waiting.

## 8. Is `releaseReady=true` justified?

**Partly. I would not let it stand unqualified.**

What it legitimately certifies, and what I independently confirmed: all 19 deterministic checks
pass; both V-13 evidence artifacts validate against recomputed digests and resist tampering and
scope confusion; the conservative overhead gate passes with complete coverage and zero uncaused
invocations; both providers prove a subscription-first route with no API-key, Console, cloud,
custom-provider or custom-base-URL path; no purchase, top-up, add-credit or reset-credit call
exists anywhere in production code; and the model-start guards hold even when the durable
projection is fed fabricated billing evidence. Against plan §12's release gates specifically —
billing gates, deterministic/crash/duplicate/permission/migration/security/accessibility/resource
suites, zero uncaused invocations, ≤1.05 overhead, honest terminal states, no unresolved
critical/high threat-model finding — I found nothing that fails. The flag's own logic is sound and
conservative: it requires `deterministicPassed && realProviderReady && v13.status === "passed"`,
and I watched it correctly drop to `false` the moment a single forbidden environment variable was
present.

Why I would still qualify it: `releaseReady` in `tools/run-all.ts:165` is computed purely from
suite exit codes, live doctor readiness and evidence validity. It cannot see whether the product
actually delivers the approved user experience, and on that axis the implementation falls short
of `collab-product-v3`. A user cannot reach any run but one (F-2), so the persistent run list and
readable completed outcomes that plan §1.7 promises do not exist in practice, and a run awaiting
their decision is silently unreachable — which undercuts the honest-disagreement routing that is
the product's stated reason for existing. A Codex limit is reported as a Claude limit whenever the
error text mentions the workspace path (F-1), which happens by default in this very repository, so
plan §7's limit semantics are provably wrong on the recovery path users depend on. Budget
exhaustion, a first-class §3.8 state, dead-ends (F-3). Durable billing records can carry
fabricated proof strings that render identically to observed ones (F-4), which is in tension with
the authoritative requirement that UI and durable state clearly distinguish the routes. And
cancellation skips the approved interrupt-then-grace contract entirely (F-7).

The second pass adds a distinct reason for caution that is not about the user experience: two of
the invariants the flag implicitly certifies are asserted rather than measured. `uncaused` and
`nestedUsageComplete` are written as literals on every real usage row (F-5), and `C_upper` is a
per-stage constant that cannot grow with real coordination cost (F-8). Both happen to be *true*
today — I traced the control flow and reproduced the arithmetic — but `releaseReady` would report
identically if they were false, which is the weaker of the two things one might want the flag to
mean.

My recommendation: keep the aggregate's `releaseReady=true` as an accurate statement about the
billing, zero-call, causality and consensus-integrity envelope — that envelope is real and I could
not break it, and the fail-closed behaviour I triggered accidentally (§2.1) is genuine evidence
that it works. Do not treat it as sign-off that the approved MVP is delivered. Fix F-1 and F-2
before the user relies on the product for more than one collaboration; then F-3, F-4, F-5 and F-7;
and either implement or explicitly defer F-11 in the handoff. F-5 in particular is cheap to fix and
converts a construction-dependent property into an enforced one.

## 9. Review integrity

I modified exactly one repository file: this review. All three tripwire hashes and all five
acceptance-artifact hashes were re-verified **after** all review activity and are unchanged:

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

All probe scripts, service state directories, test workspaces and JSON output were written under
`/private/tmp` and the session scratchpad; temporary probe files created inside `product/` for
module-resolution reasons were removed, and I confirmed none remain. Authentication, provider
configuration, and the consumed authorization files were not touched, and no software was
installed.

---

## Addendum: remediation disposition (2026-07-26, not written by the reviewer)

Appended by the remediation session so this review carries its current
status; nothing above this line was altered. All twelve findings were
actioned the same day. Full detail, judgment calls open to challenge, and
re-verification results: `docs/remediation-report.md` and the
"Post-review remediation (2026-07-26)" section of
`docs/implementation-handoff.md`.

- F-1 fixed — typed `ProviderFailure` carries the role; substring inference deleted; regression test.
- F-2 fixed — run list/switcher, recency-ordered `/api/runs`, pending-action counts.
- F-3 fixed — dedicated `budget_exhausted` card: counts, both positions, all five §3.8 actions.
- F-4 fixed — `simulated: true` billing statuses, "Demo billing" chip, `fixture` param dev-gated; V-9 updated.
- F-5 fixed — `uncaused`/`attributionComplete`/`nestedUsageComplete` derived; no-claim burst fixture fails the gate.
- F-6 fixed — `authorizationClaim` required; the two pre-mechanism artifacts grandfathered by exact digest with recorded reasons; V-14 still `releaseReady: true`.
- F-7 fixed — `turn/interrupt` + bounded grace before SIGTERM→SIGKILL; ordering test. Deviation: child-scoped, not process-group.
- F-8 implemented as `real-burst-v2` after independent verification from the durable rows: recorded trace re-measures at 1.0412236139207862 under v2 (v1 constants 599/943/847/590 confirmed exactly). Correction: the review's "1.0160" used a 975-byte Goal Packet estimate; the recorded packet is 1,045 bytes ⇒ 1.0163.
- F-9 fixed via the restrict option — exactly `authMethod === "claude.ai"`, single-sourced; "oauth" fixture fails closed (no primary evidence found for pinning it).
- F-10 fixed — `secondary` extracted, structural completeness required, either window at 100% triggers existing-credits; both windows in proof lines.
- F-11 partial — budget controls and run export wired; permission preset, attachments, stop conditions, legacy browser explicitly deferred in the handoff.
- F-12 fixed — evidence ledger rendered in the outcome view.

Tripwires and all five acceptance artifacts re-verified byte-identical after
remediation; zero model starts; the remediation aggregate (19/19,
`releaseReady: true`) is at `/private/tmp/codex-remediation-acceptance.json`.
