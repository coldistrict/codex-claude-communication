# Codex analysis — two-arm overhead gate and advisory supervisor

Date: 2026-07-27  
Scope: read-only design analysis of `advisor-and-gate-proposal.md`  
Implementation status: nothing in this document is implemented

## Executive verdict

| Part | Verdict | Required disposition |
|---|---|---|
| A — two-arm overhead gate | **Defective as written, repairable** | Keep the two-arm idea, but restore `S_lower > 0`, split byte-attributed mixed-call framing from token-attributed coordination calls before applying a byte allowance, count worker calls only, derive and pin the 8 KiB constant, and replace the proposed interrupting `needs_input` breach card with a non-blocking status/notice. |
| B — advisory supervisor | **Needs change** | The adviser concept and zero-authority intent are sound. Do not widen `ProviderRole` or the core event actor into an authority-bearing pseudo-provider. Add a separate ready-queue role and kernel-owned adviser sidecar, harden model authorization and no-tool execution, make triggers typed and restart-safe, scope accounting honestly, and preserve core consensus/terminal invariants. |

The implementation should land Part A first and prove its regressions before
starting Part B.

## Evidence read

The following were read in full where requested:

- `product/docs/advisor-and-gate-proposal.md`;
- `tasks/2026-07-25-collaboration-product-blueprint/final-plan.md` §§3.7,
  5.1, 8, and 12;
- `product/docs/implementation-handoff.md`, including the 2026-07-27
  interactive-resource coordination section;
- `product/docs/remediation-report.md`;
- the current `overhead.ts`, `queue.ts`, `model-guard.ts`,
  `codex-client.ts`, `claude-adapter.ts`, `real-runner.ts`,
  `coordinator.ts`, `verify-zero-call.ts`, and `run-all.ts`.

The adjacent contracts, event store, projection, server view, migration/export
code, relevant tests, pin manifest, pinned Claude SDK type declarations, and
pinned Codex app-server schema snapshot were also inspected because the
proposal changes their contracts.

Primary pinned transport evidence:

- Claude Agent SDK is exactly `0.3.220`; `sdk.d.ts` exposes
  `Options.model?: string`, `Options.effort?: EffortLevel`,
  `Options.thinking?: ThinkingConfig`, `Query.supportedModels()`, canonical
  `ModelInfo.resolvedModel`, per-model supported effort levels, and the actual
  selected model in the `system/init` message.
- Codex is exactly `codex-cli 0.146.0-alpha.3.1`; its pinned v2 schema exposes
  `model` and `effort` overrides on `turn/start`, `model` on
  `thread/start`/`thread/resume`, selected `model` and `reasoningEffort` in
  thread start/resume responses, and `model/list` rows with an exact model id,
  default model, default effort, and supported efforts.
- The Codex schema deliberately types `ReasoningEffort` as a non-empty string,
  not a closed enum. Therefore the implementation must validate requested
  values against the selected row returned by `model/list`, not against a
  guessed static Codex enum.

## Part A — corrected two-arm overhead gate

### Defects in the proposed formula

1. **It drops the existing positive-useful-work condition.** The proposal's
   displayed expression omits `S_lower > 0`. A run with no useful work could
   therefore pass solely because its charged bytes are below the absolute
   allowance. `S_lower > 0` must remain outside the OR.

2. **`C_upper` is not uniformly measured in bytes.** Current
   `reportOverhead()` adds all provider-reported tokens for a
   `coordination` invocation, but adds UTF-8 bytes for the attributable
   coordinator-owned portion of a `mixed` invocation. Comparing that combined
   scalar to a value labelled "bytes" is dimensionally false. The absolute
   arm may apply only to the byte-attributed mixed-call component. A pure
   coordination call or an unattributed whole-call charge must make the
   absolute arm ineligible; it can pass only through the ratio arm.

3. **`burstCount` cannot include adviser usage.** Otherwise each adviser wake
   would increase the worker loop's absolute allowance. It must count only
   unique worker usage rows, one per guarded worker invocation.

4. **The current usage key is stage-shaped, not invocation-shaped.** The
   `(run_id, burst_key)` primary key upserts. Before calling its row count a
   call count, production must use a unique durable invocation/wake id for
   every worker call and cross-check it against its ready claim. Recovery must
   not overwrite an earlier call's accounting.

5. **The 8 KiB number is unpinned policy.** The recorded v2 trace has
   `15,426 / 6 = 2,571` charged bytes per burst. Three times that is `7,713`;
   rounding up to the next power of two gives `8,192`. This is a defensible
   personal-alpha allowance only if the derivation, reference fixture digest,
   multiplier, rounding rule, and resulting constant are recorded in
   `pin-manifest.json`.

6. **The claim that all genuinely wasteful coordinators fail at every scale is
   too strong.** An absolute allowance intentionally forgives coordination up
   to a policy limit. Waste below that limit passes. The honest claim is that
   the rule caps the absolute exception while retaining the 5% arm for larger
   runs.

7. **The proposed live card is interrupting in the current kernel.**
   `needs_input` changes the run to `waiting_user`; it is not a non-blocking
   notification. In addition, a live report is non-monotonic: later useful
   work can repair the ratio and later calls increase the aggregate
   allowance. A permanent card on the first provisional failure can become
   stale.

### Agreed gate

Preserve the historical compatibility scalar and add an honest breakdown:

- `M_worker`: all provider-reported tokens for worker calls only;
- `Q_tokens`: full token charges for coordination-only worker calls and
  mixed calls whose byte attribution is unavailable;
- `B_bytes`: UTF-8 bytes of attributable coordinator-owned content inside
  mixed worker calls;
- `C_upper_compat = Q_tokens + B_bytes`, retained so the recorded v2 trace and
  historical ratio remain numerically unchanged;
- `S_lower = M_worker - C_upper_compat`;
- `N_worker`: unique, causally claimed worker invocations with usage rows.

The v2 gate is:

```text
workerCoverageComplete
∧ globalUncausedInvocations == 0
∧ S_lower > 0
∧ (
    M_worker / S_lower ≤ 1.05
    ∨ (
        absoluteEligible
        ∧ Q_tokens == 0
        ∧ B_bytes ≤ 8192 × N_worker
      )
  )
```

`absoluteEligible` requires complete per-call usage and complete byte
attribution for every non-useful worker call. No coordination-only model call,
whole-invocation fallback charge, missing usage, or missing attribution can be
forgiven by the byte arm.

Add these explicit report fields:

- `gateVersion: "overhead-gate-v2"`;
- `workerBurstCount`;
- `coordinationTokenUpper`;
- `mixedCoordinatorBytes`;
- `absoluteAllowanceBytes`;
- `absoluteEligible`;
- `passedBy: "ratio" | "absolute" | null`.

Keep the existing `total`, `coordinationUpper`, `usefulLower`, `ratio`,
coverage, causality, provider breakdown, and `passed` fields for compatible
consumers. The recorded final trace must still report total `389,629`,
compatibility `C_upper` `15,426`, ratio `1.0412236139207862`, and
`passedBy: "ratio"`.

Pin the following derivation, not a dynamic self-adjusting formula:

```text
reference classifier: real-burst-v2
reference fixture SHA-256:
  627534eefa05530589e8685b51fd05b9bcffec1f5965f80096b07a8b54f35a7
reference charged bytes: 15,426
reference worker bursts: 6
multiplier: 3
rounding: next power of two
result: 8,192 bytes per worker burst
```

Re-deriving the allowance from the run being judged would let added overhead
raise its own limit and is forbidden. A future constant change requires a new
gate version, new pinned derivation, and both pass/fail regressions.

### Live visibility

The server may render the current gate result continuously, but it must label
an active run's result **provisional**. A provisional failure gives the chip
failing styling but does not create an `ActionCard` or change run state.

At a stable boundary (terminal outcome, explicit disagreement/waiting-user
boundary, or cancellation after provider cleanup), persist one typed,
non-blocking `overhead_gate_breached` system notice if the report is still
failing. This notice must not use `needs_input`. It may trigger the adviser
once for that breach episode. A later status transition must clear a
provisional UI warning; no stale durable "action needed" card may remain.

This changes the immutable plan's single 1.05 arm and must be recorded as an
implementation deviation. It does not alter the bytes or claims of the
recorded V-13 artifacts.

## Part B — corrected advisory-supervisor design

### Keep these properties

- Off by default and opted into per run.
- Visible, separately budgeted, event-driven, and never polled.
- Full selected-provider subscription/billing preflight before every model
  start.
- Same guarded adapter model-bearing sites.
- Schema-constrained, redacted input and all-or-nothing validated output.
- Findings linked to durable event ids.
- Notes under service state, never the user's workspace.
- Adviser failure never fails, blocks, signs, or terminalizes the worker run.

### Type and authority boundary

Do **not** change:

- `ProviderRole = "codex" | "claude"`;
- `PublicPacket.from`;
- provider worker maps, billing maps, useful-work budgets, openings, or
  signoffs;
- the two-provider consensus rule.

Add:

- `ReadyRole = ProviderRole | "advisor"` for `ReadyWorkItem` and
  `ReadyQueue.claim()`;
- `AdvisorProvider = ProviderRole` for the actual selected transport;
- an adviser projection/sidecar that is separate from worker projections.

SQLite's current `ready_work.role` is unconstrained `TEXT`, so the new queue
value itself does not require an `ALTER TABLE`. The contract ripple is still
material: every method that currently assumes a queue role indexes
`workers[role]` or `budgets.provider[role]`. Adviser enqueue/claim/accounting
must use separate methods and must never pass through worker `work_claimed`
projection logic.

The stronger kernel boundary is a dedicated, append-only adviser sidecar
rather than adding `"advisor"` to the core `Actor` union:

- core system/user events create typed trigger facts;
- the ready queue stores the causal adviser item;
- a kernel-owned adviser API stores wake claims, failures, validated
  observations, and event-id links in an adviser table/hash chain;
- the adviser model never calls `EventStore.append`;
- the core event log, terminal-state rule, worker projections, packets,
  manifests, and signoffs remain unchanged.

This also permits a non-blocking retrospective after a core terminal event
without weakening the existing "no core mutation after terminal" guarantee.
The adviser sidecar must bind every row to the run, trigger event, ready-work
id, selected provider, and previous adviser-sidecar hash.

If the implementation instead adds a core `advisor` actor, it must replace
the current negative authority sets with an exhaustive event-type-to-actor
matrix and prove that no unclassified event defaults open. The sidecar design
is preferred because it is smaller and stronger.

### Model-start authorization

The current `ModelAuthorization.kind` is not checked by
`ModelStartGuard.authorize()`; the guard checks only run id and provider.
Adding the string `"advisor_observation"` to the union would therefore add no
enforcement by itself.

Add a purpose-bound, one-use adviser authorization:

- kind exactly `advisor_observation`;
- run id and selected provider;
- ready-work id and trigger event id;
- issued timestamp and unique authorization id;
- exact expected purpose passed to the existing adapter model-bearing method.

The guard must reject a worker authorization on an adviser call, an adviser
authorization on a worker call, wrong provider/run/claim/trigger, and reuse of
an adviser authorization id. The claim must exist before the guarded model
start. Usage recording must independently re-derive the same binding.

### No-tool execution profile

Reuse the existing adapter classes and the existing
`ClaudeAgentAdapter.startBurst()` / `CodexAppServerClient.runBurst()` call
sites, but add an explicit `executionProfile: "worker" | "advisor"`:

- adviser cwd is a service-owned run-state runtime directory, never the user
  workspace;
- Codex uses `read-only`, no approval path, fixed instructions, and declines
  every server tool/permission request;
- Claude uses `tools: []`, `permissionMode: "dontAsk"`, no MCP, no skills,
  no subagents, no web, `maxTurns: 1`, and no `canUseTool` path;
- neither adviser transport can acquire a path, heavy-work, browser, or
  computer-use lease;
- note files are written by validated service code, not by the model.

`readOnly: true` alone is insufficient for Claude because the current worker
profile still leaves read/search tools available. A read-only Codex sandbox
alone is likewise weaker than a no-tool adviser rooted outside the project.

The adviser prompt must use a product-authored system/developer instruction
and a typed JSON data envelope. Event payloads are untrusted data. A resumed
session may improve provider caching, but the product must not promise that
each wake "pays only for the delta"; only provider-reported cached and
uncached usage can establish that.

### Provider and reasoning profile

Expose provider plus reasoning effort, not an invented cross-provider model
ranking:

- provider: `claude` (default) or `codex`;
- effort profile: `high` (UI may describe it as strong) or `medium`;
- one exact canonical model id per provider, selected once by the deterministic
  rule below and pinned in `pin-manifest.json`;
- service tier remains exactly `standard` for Codex.

Metadata-only selection rule during implementation:

1. Read the provider's model catalog through the existing metadata connection.
2. Select the single account-visible default row.
3. Resolve aliases to the canonical model id
   (`resolvedModel ?? value` for Claude; the exact model/id field for Codex).
4. Require that the row advertises both `high` and `medium`.
5. Pin the exact canonical id and the two effort mappings.
6. Before every adviser wake, require that the same exact row is still
   available and still advertises the chosen effort. Unknown or drifted state
   fails the adviser wake closed without affecting the worker run.

Do not guess model ids from marketing names, use moving aliases such as
`sonnet`, infer strength from descriptions, silently downgrade effort, switch
providers, or enable a fallback model. Record the actual selected model from
Claude `system/init`; validate the Codex thread response and treat a
`model/rerouted` notification as a failed adviser observation.

If a provider has no exact default row supporting both efforts, keep that
provider unavailable for the adviser and state the limitation. Do not fake a
tier selector.

### Trigger contract

Every wake has a typed condition-instance id and a causal durable record.
Debounce keys are semantic instances, not error-message text.

| Trigger | Exact condition instance |
|---|---|
| `repeated_failure` | Two consecutive typed failures for the same provider, stage, and normalized failure code, with no successful burst between them. Trigger on the second failure; a success resets the streak. |
| `stall` | A persisted eligible worker-state epoch exceeds its per-state deadline with no later trusted runtime-activity event. |
| `disagreement_declared` | The exact typed disagreement event id. |
| `budget_exhausted` | The exact typed `budget_exhausted` card/event id; never title/body parsing. |
| `unknown_resource_identity` | A trusted classifier/registry result degraded a browser claim to the global identity. Once per degradation episode; model-supplied ids never qualify. |
| `overhead_gate_breach` | A stable, non-blocking Part A breach event, not a transient first sample. |
| `resource_degradation_persisted` | One resource-governor degradation episode persists for five minutes. Enqueue then, but do not claim/start the adviser until `admitHeavyWork` is true again. |
| `user_request` | A user-authored `advisor_requested` event created by the button; each click is a new instance, subject to budget. |
| `terminal_retrospective` | One sidecar trigger after a non-cancel terminal event. Cancellation never starts a new model call. |

Stall thresholds must be pinned and per state:

- `working`: 10 minutes with no trusted, structured provider activity;
- `waiting_lease`: 10 minutes in the same lease-wait epoch;
- `recovering` or `replacing_context`: 2 minutes in the same epoch;
- `waiting_permission`, `waiting_user_input`, provider-limit waits,
  preflight blocks, not-started, waiting-handoff, signed, and terminal states:
  no automatic stall wake.

Provider notification/message callbacks must persist coalesced, text-free
runtime-activity facts (at most one per 30 seconds) so "working" means no
trusted activity, not merely no public packet. Timers use `setTimeout`, but
their epoch id and deadline are durable and are reconstructed on service
restart. No interval scans and no text parsing are permitted.

Adviser work is low priority. It may be enqueued while workers run, but it is
claimed only at a provider-safe boundary, never concurrently with a worker
burst on the selected provider and never while the resource governor refuses
heavy work.

Reserve the default three-wake budget as two reactive/user wakes plus one
non-cancel terminal retrospective. Extensions are positive integer,
user-authored, and audited. Failed metadata preflight consumes no model-wake
unit; a guarded model start does. A claimed wake whose process outcome is
unknown after restart is recorded as an adviser failure and is not replayed.

### Input, output, cards, and notes

Input is the redacted delta from the last adviser-observed core sequence
through the trigger sequence plus an allowlisted projection summary. Bound
bytes, array lengths, and string lengths; record omitted byte counts and
digests rather than silently dropping data. Never provide secrets, raw auth
metadata, capability tokens, or a writable project path.

Both providers must receive an actual JSON Schema:

- Codex `runBurst()` must expose the already-supported app-server
  `turn/start.outputSchema`;
- Claude continues to use `outputFormat: json_schema`;
- local validation independently enforces the same bounds;
- malformed output is recorded as one adviser failure and nothing is
  partially applied.

The model may return only observation data and an optional recommendation
**code** from a fixed non-permission allowlist. The service, not the model,
maps a code to product-authored text/actions. Adviser output may never create
or recommend `Allow once`, `Allow for task`, lease release, billing change,
signoff, challenge resolution, goal mutation, or a worker message. Adviser
cards are non-blocking adviser cards, not core `needs_input` cards. Only a
subsequent user-authored event can invoke an existing user decision.

Write mode-0600, symlink-safe, atomically replaced/created files only under:

```text
<state-root>/runs/<validated-run-id>/advisor/
```

Required files:

- `observations.jsonl`: append-only, service-enveloped, hash-linked
  observations;
- `notes.md`: atomically replaced readable synthesis;
- `retrospective.md`: exclusive create once, or a deterministic
  "skipped because the run was cancelled/budget unavailable" header.

Every file begins with the fixed untrusted-model-output warning. Redact output
again before persistence. UI rendering is text-only/escaped. Export copies
these files and includes their checksums; it never follows links.

### Accounting

Separating adviser usage from the worker ratio is the correct product choice,
but the proposal's rationale overclaims what remains guaranteed.

Use separate durable adviser usage rows keyed by wake id rather than adding
`"advisor"` to the worker attribution classifier. Report:

- `workerOverhead`: the Part A worker gate;
- `advisorUsage`: full input/cached-input/output/reasoning by selected
  provider, wake count, usage coverage, and adviser uncaused count;
- `combinedModelUsage`: worker plus adviser tokens;
- `combinedCoordinationRatio`: informational, treating all adviser usage as
  coordination and never using it as the worker pass/fail predicate.

The global zero-uncaused guarantee and full-usage-coverage release check cover
both buckets. Adviser usage never enters `M_worker`, `S_lower`, or
`N_worker`, so it cannot change the worker ratio or inflate the absolute
allowance.

UI and handoff language must say **"worker-loop overhead gate"**, not imply
that an adviser-enabled run keeps total product model overhead below 1.05.
With the adviser disabled (the default), the historical guarantee is
unchanged. With it enabled, the worker loop retains the gate and total
adviser cost is separately visible and bounded by wakes; the total
model-usage ratio may exceed 1.05.

### Persistence and migration

Bump the collaboration database schema and pin manifest version for:

- adviser sidecar wake/observation/failure rows;
- adviser usage rows;
- any ready-work completion/outcome columns needed for no-replay recovery;
- adviser projection/configuration.

Use the existing quiesced-WAL, verified-byte-backup transactional migration
path for schema v1 to v2, provide an operator command, test rollback and
newer-schema refusal, and leave legacy worker/usage/ready rows semantically
unchanged. The queue's new role value alone needs no SQL column migration, but
the feature as a whole does.

## Answers to the five open questions

1. **8,192 bytes per burst:** keep 8,192 for personal alpha, but derive and
   pin it as `nextPow2(3 × 15,426 / 6)`. Apply it only to attributable mixed
   framing bytes, require `S_lower > 0`, and make pure/unknown coordination
   ineligible for the absolute arm. It is an explicit allowance, not proof
   that every passing run is non-wasteful.

2. **Tier selection:** both pinned providers expose exact model and effort
   knobs. Claude SDK `0.3.220` has `model`, `effort`, adaptive `thinking`,
   `supportedModels()`, canonical `resolvedModel`, supported-effort metadata,
   and actual model reporting. Codex app-server
   `0.146.0-alpha.3.1` has `turn/start.model`,
   `turn/start.effort`, thread model overrides/responses, and `model/list`
   supported efforts. Exact canonical model ids and `high`/`medium` values can
   be pinned; provider account availability cannot, so it must be
   metadata-verified before each wake. Neither provider exposes a stable
   machine-readable "stronger than" ordering, so do not invent one.

3. **Stalls and resource degradation:** yes, thresholds must be per state.
   User/permission/limit waits are excluded. Use the pinned 10m/10m/2m
   eligible-state thresholds above with durable epochs and trusted activity.
   Add persistent resource-governor degradation as a trigger, but never start
   the adviser while the governor is refusing heavy work.

4. **Ready-queue role widening:** add `ReadyRole`, not `"advisor"` to
   `ProviderRole`. The SQLite column accepts the value without alteration,
   but queue APIs, claim causality, scheduler logic, tests, and recovery
   ripple. New adviser persistence/accounting still warrants a versioned v1
   to v2 database migration.

5. **Accounting exclusion:** exclude adviser usage from the worker gate, but
   do not claim the old 1.05 promise covers total adviser-enabled model use.
   Show a separate full adviser bucket plus an informational combined ratio;
   keep global coverage and no-uncaused checks. This is honest isolation, not
   free coordination.

## Mechanical zero-call audit finding

The proposal's narrow claim is correct under one condition: invoking the
existing adapter methods from new adviser orchestration does not add a source
site matching the current audit.

`verify-zero-call.ts` scans adapter/service source and currently requires:

- one literal `request("turn/start"` site;
- two Claude `query({` sites total;
- one `prompt: input.prompt` model query;
- one `prompt: noModelMessages()` metadata query;
- two guard calls;
- zero forbidden billing calls.

Calling `runBurst()` or `startBurst()` additional times from an adviser
scheduler does not change those static counts. Adding Codex `model/list`
metadata on the existing connection also does not add a turn site, and
calling Claude `supportedModels()` on the existing no-model metadata stream
does not add a `query()` site. Therefore 1/1/1/0 can remain unchanged.

This audit counts implementation sites, not runtime invocations, and its
regexes are bypassable by aliases or computed property calls. Preserve the
counts, add an AST/file-and-symbol allowlist or equivalent structural
regression, and add deterministic guard-counter tests proving every adviser
fake wake uses the existing guarded sites. Do not silently bump an expected
count.

## Existing guarantees and required protections

| Guarantee | Proposal risk | Required prevention |
|---|---|---|
| Billing | More subscription/credit-bearing model starts and selectable models. | Selected-provider full preflight before every wake; exact pinned model/provider/standard-tier validation; no fallback/API key/custom provider; separate adviser billing evidence; blocked preflight starts zero models. |
| Causality | Queue role widening, static audit confusion, and crash after claim. | Dedicated `ReadyRole`; trigger/claim/auth/usage binding; one-use adviser authorization; unique wake usage rows; no-trigger counter remains zero; claimed-unknown wakes fail without replay. |
| Consensus | Treating adviser as a provider/actor could let it post packets, consume worker budget, sign, or affect equality. | Leave `ProviderRole`, packets, manifests, signoffs, worker maps, and core terminal state unchanged; kernel sidecar only; no automatic delivery of notes to workers. |
| Injection posture | Resumed context accumulates untrusted event text; model-authored card actions or Markdown could become instructions. | No tools/leases/workspace, fixed system framing, typed redacted delta, output schema plus local validation, fixed recommendation codes, escaped UI, untrusted headers, notes treated as hypotheses. |
| Overhead honesty | Separate bucket could be described as preserving a product-total 1.05 promise; adviser wakes could inflate the absolute allowance. | Relabel as worker-loop gate; adviser excluded from all worker numerator/denominator/burst counts; show full separate and combined informational accounting; global coverage/causality still fail closed. |
| Terminal-state integrity | A model retrospective after completion conflicts with the core store's terminal append rejection. | Append retrospective/wake evidence only to the kernel-owned sidecar after terminal; never reopen or append adviser events to the core state machine. |
| Permission and lease separation | "Read-only" adapters can still request/read tools and an adviser recommendation could influence permission decisions. | Explicit no-tool profile outside the project; decline every request; no permission action codes; no lease APIs reachable from adviser code. |

## Disagreements with proposal reasoning

- The two-arm concept is right, but the displayed rule is not safe without
  `S_lower > 0` and a byte-only absolute-eligibility split.
- A flat allowance does not make every wasteful coordinator fail; it defines
  tolerated absolute waste.
- A `needs_input` event cannot currently be both a card and non-interrupting.
- A provider session may reuse context/cache, but "pays only for the delta" is
  not mechanically guaranteed.
- `ModelAuthorization.kind` currently provides no purpose enforcement.
- `ProviderRole` widening would grant the adviser accidental compile-time
  access to worker billing, budgets, packets, and consensus.
- The current ready queue has claim but no completion/requeue state; a crash
  after claim needs an explicit no-replay failure record.
- A single 10-minute stall threshold would misdiagnose user-paced waits.
- Starting a resource-diagnosis model while degraded would work against the
  governor.
- An adviser action that recommends permission or authority would "influence
  permissions", contradicting the proposal's own non-negotiable boundary.
- A post-terminal model retrospective cannot use the current core event log
  without weakening terminal enforcement.
- Static call-site counts remain unchanged only when the existing adapter
  methods are genuinely reused; the current regex audit alone is not proof of
  guard dominance.

## Ready-to-run implementation prompt

```text
Implement the agreed two-arm worker-overhead gate and optional advisory
supervisor in:

Repository: /Users/coldistric/source/repos/codex-claude-communication
Product:    /Users/coldistric/source/repos/codex-claude-communication/product

Read completely before editing:
1. product/docs/codex-advisor-analysis.md (this is the controlling design)
2. product/docs/advisor-and-gate-proposal.md (origin proposal; where it
   conflicts, the Codex analysis controls)
3. tasks/2026-07-25-collaboration-product-blueprint/final-plan.md §§3.7,
   5.1, 8, and 12
4. product/docs/implementation-handoff.md, including the 2026-07-27
   interactive-resource section
5. product/docs/remediation-report.md
6. The current contracts, kernel store/projection/overhead/queue, adapters
   (policy, model guard, Codex client, Claude adapter), service
   (real runner, coordinator, server, resources), migration/export, UI,
   canary evidence, tools/verify-zero-call.ts, tools/run-all.ts, and their
   tests.

Hard constraints

- Implement Part A completely and make its focused regressions pass before
  starting Part B.
- Do not run V-13, create/reuse a canary authorization, or initiate any
  provider model turn. Metadata-only model catalog/preflight/doctor calls are
  allowed. Use deterministic fake adviser ports for all model-bearing tests.
- Do not modify:
  - tasks/2026-07-25-collaboration-product-blueprint/final-plan.md
  - tasks/2026-07-25-collaboration-product-blueprint/verification.md
  - product/package-lock.json
  - any existing file under product/artifacts/
  - product/docs/advisor-and-gate-proposal.md
- Record the eight protected hashes before work and verify them again at the
  end against product/docs/remediation-report.md.
- Preserve the pinned Codex/Claude versions, subscription-only billing
  policy, standard Codex service tier, forbidden-call/flag posture, exact
  two-provider consensus, immutable Goal Packet, permission/lease separation,
  terminal core state, and zero no-op wakes.
- Do not widen ProviderRole. Do not add adviser-authored PublicPackets,
  candidates, signoffs, goal changes, billing changes, permissions, leases,
  or worker messages.
- Do not add a new model-bearing transport site. Reuse the one guarded Codex
  turn/start and one guarded Claude model-query site. Keep the zero-call audit
  result exactly 1 guarded Codex turn, 1 guarded Claude model query, 1
  metadata-only Claude query, 0 forbidden billing calls.
- No new dependency is necessary; keep the lockfile byte-identical.
- Preserve user changes and do not use destructive git/filesystem commands.
  This workspace has no Git metadata, so report exact changed files instead
  of claiming a commit or clean diff.

Ordered work — Part A first

1. Record baseline tripwire hashes and run the zero-call audit.
2. Refactor overhead accounting to retain the existing compatibility scalar
   while separately reporting:
   - worker model tokens;
   - full-token coordination/unattributed charges;
   - mixed-call coordinator-owned UTF-8 bytes;
   - unique worker invocation count.
3. Implement overhead-gate-v2 exactly:
   coverage complete; global uncaused=0; S_lower>0; then ratio<=1.05 OR
   (absolute eligible, token coordination charge=0, and mixed bytes <=
   8192*unique worker invocations). Adviser usage must never enter worker
   total, useful lower bound, ratio, or burst count.
4. Add gateVersion, workerBurstCount, coordinationTokenUpper,
   mixedCoordinatorBytes, absoluteAllowanceBytes, absoluteEligible, and
   passedBy. Preserve existing fields.
5. Pin the constant and derivation in pin-manifest.json:
   real-burst-v2; fixture SHA-256
   627534eefa05530589e8685b51fd05b9bcffec1f5965f80096b07a8b54f35a7;
   15,426 bytes; 6 bursts; multiplier 3; next-power-of-two rounding; result
   8,192.
6. Make worker usage keys invocation-unique and bind every row to its exact
   durable ready claim. Do not overwrite an earlier invocation on retry.
7. Render active results as provisional. Failing styling is non-blocking.
   Persist only a typed non-blocking stable breach notice; never use
   needs_input for overhead visibility and never change the core run state.
8. Make all Part A focused tests pass before continuing.

Required Part A regressions

- Existing large-shape 1.0400 passes by ratio.
- A large-shape 1.0600 fails both arms.
- A small legitimate all-mixed run fails ratio but passes absolute.
- A wasteful all-mixed run exceeds the allowance and fails both.
- S_lower<=0 never passes the absolute arm.
- A pure coordination invocation and an unattributed whole-call charge are
  absolute-ineligible.
- Missing usage/attribution and every uncaused invocation fail.
- The recorded final trace remains exactly total 389,629,
  compatibility C_upper 15,426, ratio 1.0412236139207862, passed by ratio.
- Repeated/recovery calls create distinct usage rows and distinct causal
  bindings.
- Provisional breach UI does not create an action, interrupt, or waiting_user
  transition; stale provisional styling clears.

Ordered work — Part B

9. Add immutable per-run adviser configuration, off by default:
   enabled, selected provider (Claude default), effort high/medium, two
   reactive wake units plus one reserved non-cancel retrospective unit.
10. Add ReadyRole = ProviderRole | "advisor" only in ready-queue contracts.
    Implement separate adviser enqueue/claim/scheduling so no adviser role is
    ever used to index worker/billing/budget/signoff maps.
11. Bump the DB/pin schema from v1 to v2. Add kernel-owned, hash-linked adviser
    sidecar tables for wake claim/outcome/observation/failure and unique
    adviser usage keyed by wake id. Add any ready-work completion fields
    needed for explicit no-replay recovery. Provide and test a quiesced-WAL,
    verified-backup transactional v1->v2 operator migration and rollback.
12. Keep the core Actor/ProviderRole/packet/consensus/terminal state
    unchanged. Core system/user events may record typed trigger facts; only
    the kernel adviser sidecar may record adviser output, including after a
    terminal core event.
13. Harden ModelStartGuard with an exact, one-use
    advisor_observation authorization bound to run, provider, ready-work id,
    trigger event id, purpose, and authorization id. Prove worker/adviser
    cross-use and replay fail.
14. Add an adapter executionProfile. Adviser execution is rooted in the
    service run-state directory, has no tools/MCP/skills/subagents/web, no
    permission callback, no lease route, Claude maxTurns=1/dontAsk/tools=[],
    Codex read-only/decline-all, bounded timeout, and service-written notes.
15. Add outputSchema support to the existing Codex runBurst turn/start call.
    Use provider JSON schema plus independent bounded local validation for
    both providers. Apply no partial result on malformed output.
16. Through metadata only, use the deterministic default-row rule in the
    analysis to select and pin one exact canonical model per provider that
    advertises high and medium effort. Pass exact model+effort on every wake,
    verify the catalog before every wake, verify the actual Claude init model
    and Codex thread model, fail on drift/reroute, never use aliases,
    fallback, nonstandard service tier, or silent downgrade. If a provider
    cannot satisfy the rule, leave it unavailable and document that fact.
17. Implement typed, debounced triggers exactly as specified in the analysis:
    repeated typed failure, per-state durable stall, disagreement, typed
    budget exhaustion, trusted unknown browser identity, stable overhead
    breach, persisted resource degradation, user request, and non-cancel
    terminal retrospective.
18. Persist coalesced text-free provider runtime activity at most once per
    30s. Use durable state epochs/deadlines with restart-rehydrated setTimeout
    timers; no polling. Thresholds: working 10m, waiting_lease 10m,
    recovering/replacing_context 2m; exclude user/permission/limit/preflight,
    waiting-handoff, signed, and terminal waits. Resource degradation triggers
    at 5m but cannot be claimed until heavy work is admitted.
19. Run adviser work at low priority, never concurrently with a worker burst
    on its selected provider. A failed preflight starts no model and consumes
    no model-wake unit. A guarded start consumes one. A claimed unknown crash
    outcome becomes a visible adviser failure and is never replayed.
20. Build the typed redacted delta/projection input and fixed system framing.
    Bound and digest omissions. Validate output all-or-nothing. Accept only
    fixed non-permission recommendation codes; the service authors displayed
    copy/actions. Never deliver notes automatically to workers.
21. Write mode-0600, symlink-safe, atomic adviser files only under
    <state-root>/runs/<validated-run-id>/advisor. Include the fixed untrusted
    header. observations.jsonl is append/hash-linked; notes.md is atomic;
    retrospective.md is exclusive-once or a deterministic skip record.
    Include all three and checksums in collab export without following links.
22. Report workerOverhead, advisorUsage, combinedModelUsage, and an
    informational combinedCoordinationRatio. Global coverage and zero
    uncaused checks include both buckets; adviser tokens/calls never affect
    the worker gate or allowance. UI copy must say worker-loop overhead and
    show full adviser usage.
23. Add the hidden-when-disabled adviser lane, reason/observation/budget/model
    display, escaped note links, Ask the adviser button, non-blocking adviser
    cards, keyboard/focus/reflow coverage, and no extra live region.
24. Extend canary-evidence schemas/reporting backward-compatibly: preserved
    artifacts remain valid and untouched; adviser-disabled historical runs
    report a zero/absent adviser bucket; any future adviser canary must prove
    selected profile, trigger/claim/auth/usage binding, coverage, and no-op
    count. Do not run such a canary in this session.
25. Strengthen verify-zero-call structurally (AST/file-and-symbol allowlist or
    equivalent) while retaining exact 1/1/1/0 counts. It must reject alias or
    computed-call attempts to introduce another provider model site.

Required Part B regressions

- Adviser is off by default and causes zero metadata/model work.
- Every trigger fires exactly once per condition instance with the correct
  ready row, trigger id, reason, authorization, and unique usage key.
- No trigger means no claim, authorization attempt, or fake model start.
- Repeated failures require same provider/stage/code and reset on success.
- Fake-clock per-state stalls, exclusions, activity rescheduling, restart
  rehydration, and debounce all pass.
- Resource degradation enqueues once per episode and never starts while
  admitHeavyWork is false.
- User requests are user-authored and budgeted; cancellation starts no
  retrospective.
- Default 2+1 budget, audited positive extension, preflight-no-charge, and
  guarded-start charge pass.
- Claimed/unknown restart outcomes are failed and not replayed; unclaimed
  ready work survives restart.
- Kernel rejects every path by which adviser data could author a core event,
  worker packet, goal, candidate, signoff, completion, billing/permission
  decision, budget, lease, or worker wake.
- Worker/adviser authorization cross-use, wrong claim/trigger/provider/run,
  and authorization replay fail before the fake start counter increments.
- Both adapter profiles pass exact model/effort/output-schema parameters;
  unsupported/drifted/rerouted profiles fail closed; adviser tool and lease
  counters stay zero.
- Hostile event/prompt/card/Markdown/path content is redacted, bounded,
  schema-validated, escaped, never executed, and cannot create arbitrary or
  permission actions. Malformed output applies nothing.
- Notes stay under state root with mode/header/atomic/symlink protections and
  export checksums; user workspace bytes remain unchanged.
- Adviser failure never changes worker run state or consensus and never
  blocks completion/cancellation.
- Adviser usage is complete, separate, provider-labelled, visible, included
  in combined informational accounting, and cannot change the worker ratio,
  passedBy, or absolute allowance.
- Ready-role and v1->v2 migration/backup/rollback/newer-schema refusal pass.
- V-11 covers enabled/disabled lane, Ask button, hostile output, keyboard,
  focus, one live region, and 200% reflow.
- Zero-call audit remains exactly 1/1/1/0 and every deterministic suite
  reports current modelStarts: 0.

Verification battery

Run from product/ after focused tests:

1. npm run verify:pins
2. npm run build
3. npm test
4. npm run verify:zero-call
5. env -u ANTHROPIC_BASE_URL npm run verify:all -- \
     --v12-result artifacts/v12-30m.json \
     --v13-smoke-result artifacts/v13-smoke.json \
     --v13-e2e-result artifacts/v13-collab-e2e.json \
     --json-out /private/tmp/codex-advisor-gate-acceptance.json

The aggregate may report modelStarts: 10 only as preserved V-13 evidence.
Every command/suite executed now, including the metadata-only doctor, must
report zero current model starts. Do not write an aggregate under
product/artifacts/.

At the end:

- re-hash all eight tripwires and prove exact equality with
  product/docs/remediation-report.md;
- inspect for provider processes started by this session and ensure none
  remain (do not terminate unrelated pre-existing user processes);
- append an honest dated section to product/docs/implementation-handoff.md;
- report exact files changed, schema migration/backup behavior, pin/profile
  values actually selected from metadata, all observed command results,
  1/1/1/0 audit counts, /private/tmp aggregate path and releaseReady value,
  preserved-evidence versus current model-start counts, limitations, and
  explicit confirmation that no V-13/model turn/authorization occurred;
- do not claim releaseReady=true unless every required regression and
  surface above is actually implemented and green.
```
