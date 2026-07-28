# Implementation handoff

Last updated: 2026-07-26 (post-adversarial-review remediation)

## Outcome

The approved `collab-product-v3` personal-alpha MVP is implemented under
`product/`. Every deterministic gate (V-0 through V-12) passes with zero model
starts. The final V-14 aggregate passes all 19 recorded checks with
`releaseReady=true`. The separately authorized V-13 smoke and final
collaboration E2E both pass. The first authorized collaboration E2E is
preserved as a failed historical attempt: it reached exact consensus and
produced the exact artifact, but exposed an overhead-attribution defect that
mislabeled useful opening and signoff work as pure coordination. The corrected
classifier is covered by an exact observed-trace regression and the final real
trace measured `1.010813026479981x` under the `real-burst-v1` attribution,
within the approved `1.05x` ceiling. An independent adversarial review
(`docs/claude-review.md`, findings F-1..F-12) was subsequently actioned; see
"Post-review remediation" below, including the honest scope-downs it records.

Real collaboration is implemented and both metadata preflights are currently
ready:

- Codex metadata preflight passes on ChatGPT Plus and currently reports
  `subscription_allowance`. The latest aggregate observed
  `primary.usedPercent=76` and `credits.hasCredits=true`; credit presence did
  not block.
- The user completed official Claude subscription OAuth. The SDK-bundled
  runtime reports `authMethod=claude.ai`, `apiProvider=firstParty`, and a Max
  plan. Structured usage proves `subscription_allowance`; extra usage is
  disabled.

## Scope and base revision

- Workspace:
  `/Users/coldistric/source/repos/codex-claude-communication`
- Product:
  `/Users/coldistric/source/repos/codex-claude-communication/product`
- Base revision: unavailable. The supplied workspace has no `.git` directory
  or worktree pointer; `git rev-parse HEAD` reports that it is not a Git
  repository.
- No historical task file was edited. Final hashes:
  - `final-plan.md`:
    `dcdee33eba3a75faafc125fdb9ba856e52475505ef4c7e48a2f4f372c9e8b943`
  - `verification.md`:
    `1f4b96d594d50c238b306a367bca53ee28318928cdfd813869f7cad49516e5a0`
- All 37 generated app-server schema JSON files parsed. Planning inspection
  traversed 1,120 definitions and 173 request/notification alternatives.

## Implemented architecture

### Runtime and durable kernel

- Node `22.22.2`, npm workspaces, strict TypeScript, Preact/Vite UI.
- SQLite WAL authority through Node's built-in `node:sqlite`, synchronous FULL
  durability, append-only hash-chained events, idempotency keys, single-writer
  validation, deterministic projection replay, and persisted per-burst usage.
- Typed actor authority, terminal-state enforcement, immutable Goal Packet,
  opening barrier, exact candidate/verification digests, self-signoff checks,
  bounded provider/challenge budgets, and exact consensus or explicit
  disagreement terminal states.
- The causal ready queue is SQLite-durable, survives supervisor restart,
  deduplicates committed triggers, atomically claims by run/provider, rejects
  model launches for zero-cost wait/retry work, and is the production
  real-runner's model-wake source. Every real work claim records its ready
  item, trigger, reason, and commit-to-claim latency.
- Canonical path and heavy-resource leases cover overlap, wide/dynamic sets,
  unenforced sandboxes, stale incarnations, uncertain effects, and heavy-work
  serialization. Production provider tool approvals now acquire these leases
  before execution, hold them through the burst, and journal acquire/release
  events. Overlapping effects wait without another model start. A crash after
  mutation authorization retains the uncertain lease and produces a durable
  reconciliation card; restart never replays it.

### Provider adapters and collaboration contract

- Codex uses the pinned app-server JSON-RPC/JSONL protocol over stdio:
  initialize/initialized, account/config/rate-limit metadata, persistent
  thread start/resume, guarded turn start, notifications, usage capture,
  approval requests, interruption by process close, and completion handling.
- Claude uses only `@anthropic-ai/claude-agent-sdk@0.3.220` and the bundled
  `2.1.220` runtime resolved from the project-local optional package. A global
  Claude CLI is not required.
- Both adapters scrub API-key, cloud, and base-URL environment routes.
  Codex also audits effective config layers and verifies the post-spawn
  `modelProvider`. Claude uses no setting sources, reads official account and
  structured usage metadata, requires complete present rate-limit windows,
  ignores absent optional windows and unrelated UI metadata, corroborates the
  normalized limit list, and aborts on a contradictory `apiKeySource`.
- Real orchestration implements:
  1. metadata-only fail-closed preflight;
  2. parallel independent openings with a mechanical peer-byte barrier;
  3. Codex implementation candidate;
  4. Claude independent review/repair;
  5. content-addressed artifact verification;
  6. an exact shared Outcome Manifest;
  7. parallel exact-digest signoff;
  8. consensus or a user-visible disagreement.
- Provider sessions and usage are persisted at burst boundaries. Retry resumes
  only incomplete stages and does not call an already-signed provider.
  Cancellation aborts Claude and closes Codex. A permission wait surviving a
  service restart becomes an explicit uncertain-effect recovery card instead
  of being replayed.
- First workspace mutation asks. Reads within the workspace may pass; task
  grants are exact-path scoped. Destructive, install, network, external,
  outside-workspace, system, payment, public, and uncertain-replay actions
  always ask. Provider request payloads and public packets are redacted before
  durable storage.
- Structured limit/billing failures pause without fabricated reset times.
  Billing is refreshed again before implementation work and before signoff.
  Codex preflight compares provider-managed credit balances across refreshes
  without persisting the balance itself; V-13 fails if a balance changes while
  the displayed route remains `subscription_allowance`.

### Local service and UI

- Loopback-only HTTP service with restrictive CSP and no remote subresources.
- Data-empty public shell; single-use URL-fragment capability exchange;
  hashed durable sessions; HttpOnly SameSite=Strict cookies; session rotation;
  exact Host/Origin and CSRF checks; authenticated GET/SSE and POST actions.
- Dashboard includes immutable goal, two live provider lanes, explicit billing
  route chips, worker/wait state, public packets/provenance, action drawer,
  manifest artifacts, verification evidence, limitations, exact digests,
  live overhead, degraded mode, retry, approval, disagreement, and cancel.
- SSE reconnect is idempotent. Session and run history restore after service
  restart. Accessibility checks cover axe serious/critical findings, keyboard
  navigation and focus styling, one live region, 200% reflow, and duplicate
  rendering.
- Provider SDKs are lazy-loaded, keeping the fake/idle service within the
  target resource envelope. The governor samples RSS/event-loop lag, stops
  admitting heavy work under pressure, and serializes agents at safe
  boundaries. On macOS it also samples the local `memory_pressure -Q` signal
  and maps low-free-memory output conservatively to yellow/red degraded mode.

### Migration and operator tooling

- Read-only legacy inventory, active-run refusal, dry-run copy planning,
  content-addressed import copy, deterministic export/transcript/projection,
  checksums, and round-trip parsing. Database migration tooling now requires a
  quiesced WAL, verifies a byte backup, applies transactionally, restores and
  verifies the backup on failure/rollback, and refuses newer schemas.
- Pin verifier, zero-call structural audit, metadata-only doctor, overhead
  report, isolated service/browser soak, short-lived-authorized real canary,
  aggregate acceptance report, and bundled official Claude OAuth launcher.
- V-13 smoke is isolated from collaboration E2E. It performs metadata
  preflight, exactly two read-only bursts per provider (initial plus resume),
  asserts stable thread/session identity, complete usage, zero no-ops, allowed
  billing before and after, unchanged temporary workspace, zero forbidden
  billing calls, and a hard two-start/provider guard. Codex uses an explicit
  app-server `read-only` sandbox; Claude is limited to one turn per burst and
  every tool request is denied. The full candidate/review/signoff workflow is
  reserved for `collab-e2e`.

## Authoritative billing-policy delta

The user's 2026-07-26 instruction supersedes the historical plan's original
Codex `credits.hasCredits === false` requirement:

- Included subscription allowance is used first.
- Existing provider-managed credits may be used only after included limits.
- `credits.hasCredits=true` is not itself a block.
- Each provider is displayed as `subscription_allowance`,
  `existing_credits`, `blocked`, or `unknown`.
- Any incomplete or contradictory effective route fails closed.
- OpenAI/Anthropic API keys, Claude Console PAYG, Bedrock/Vertex/Foundry,
  custom providers/base URLs, purchases, automatic top-ups, add-credit
  nudges, and reset-credit methods are forbidden.
- Production code contains no purchase, top-up, or reset call. The zero-call
  audit verifies the only Codex turn start and Claude model query sites are
  guarded.

The approved historical `final-plan.md` and `verification.md` remain
byte-identical; deterministic V-4 fixtures implement the user's later policy.

## Changed files

All product changes are additive under `product/`:

- Root: `.gitignore`, `.node-version`, `README.md`, `package.json`,
  `package-lock.json`, `pin-manifest.json`, `tsconfig.json`.
- `packages/contracts`: shared goal, packet, manifest, event, billing,
  projection, budget, worker, and action-card contracts.
- `packages/kernel`: canonical hashing, errors, SQLite event/usage store,
  projections, SQLite-durable ready queue, leases, overhead classifier, and
  seven test suites.
- `packages/adapters`: policy/billing gates, model-start guard, Codex client,
  Claude Agent SDK adapter, fake adapter, approval bridge, limit classifier,
  and four test suites. The Claude usage parser includes regression fixtures
  for the live SDK shape (`limits`, `spend`, nullable optional windows, and
  model-scoped utilization). Codex thread start/resume supports an explicit
  read-only sandbox with regression coverage while preserving the normal
  workspace-write default.
- `packages/service`: auth/session store, coordinator, real runner, resource
  governor, secure server, CLI, bounded real-smoke runner, restart-recovery
  test, six-case smoke-harness suite, tamper-evident V-13 evidence validation,
  one-use authorization claims, observed-trace overhead attribution tests,
  deterministic full real-runner E2E, production lease integration/recovery,
  and Mac resource-pressure tests.
- `packages/ui`: Preact dashboard, styles, Vite build, production bundle, and
  Playwright/axe/restart test.
- `packages/security`: redaction, constant-time compare, path containment,
  escaping, and loopback security tests.
- `packages/migration`: legacy read/import/export implementation and tests.
- `tools`: pin, zero-call, doctor, overhead, soak, canary, aggregate, bundled
  Claude login, and JavaScript compatibility wrappers.
- `artifacts/v12-30m.json`, `artifacts/collab-acceptance.json`,
  `artifacts/v13-smoke.json`, `artifacts/v13-collab-e2e-attempt-1.json`, and
  `artifacts/v13-collab-e2e.json`.
- Post-review remediation (2026-07-26): `packages/contracts/src/index.ts`,
  `packages/kernel/src/queue.ts`, `packages/kernel/src/store.ts`,
  `packages/adapters/src/policy.ts`, `packages/adapters/src/codex-client.ts`,
  `packages/adapters/src/claude-adapter.ts`,
  `packages/service/src/real-runner.ts`,
  `packages/service/src/coordinator.ts`, `packages/service/src/server.ts`,
  `packages/service/src/canary-evidence.ts`, `packages/ui/src/app.tsx`,
  `packages/ui/src/styles.css`; tests
  `packages/adapters/test/preflight.test.ts`,
  `packages/service/test/canary-evidence.test.ts`,
  `packages/service/test/real-overhead-attribution.test.ts`,
  `packages/service/test/real-runner.integration.test.ts`,
  `packages/security/test/security.test.ts`, `packages/ui/test/a11y.ts`; new
  `packages/service/test/real-runner-causality.test.ts` and
  `packages/service/test/fixtures/v13-final-e2e-recorded.json`.
- This handoff.

Project-local generated prerequisites not intended for source control:
`node_modules/` and `.playwright/`.

## Commands and observed results

### Prerequisites and pins

- `node --version` → `v22.22.2`
- `npm --version` → `10.9.7`
- `sqlite3 --version` → `3.51.0`
- pinned Codex → `codex-cli 0.146.0-alpha.3.1`
- `npm ci` → 344 packages installed; no global install
- `package-lock.json` SHA-256 before and after `npm ci`:
  `8fc9a583680a6b6130a30461ac90c7196a6982133c3cc325442f016d93c0789f`
- `npm run verify:pins` → V-0 pass:
  - canonical Codex v2 schema:
    `b5719e63be18118f4231ce6d2d797acd4cddeb801ea44e8aceb4b7860fe6947c`
  - 97 Codex feature lines
  - Claude SDK `0.3.220`
  - bundled CLI `2.1.220`
  - bundled CLI SHA-256:
    `8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081`
- `npm run build` → strict TypeScript and Vite build pass.
- `npm run test -w @collab/adapters` after the live Claude metadata parser and
  read-only Codex sandbox correction → 4 files and 20 tests passed.
- `npm run test -w @collab/adapters -- codex-client` → 2 read-only/default
  sandbox-selection tests passed.
- `npm run test -w @collab/service -- real-smoke` → 6 deterministic harness
  tests passed with `realCanaryRun=false` and `modelStarts=0`. Fixtures cover
  exact two-start budgets, stable resume IDs, fail-closed billing, incomplete
  usage, workspace mutation, and hidden extra starts.
- `npm run test -w @collab/service` → 7 files and 21 tests passed, including
  one-use authorization replay rejection and exact observed-trace overhead
  attribution, a zero-provider-call full collaboration, production tool-lease
  serialization, uncertain-effect recovery, and resource pressure.
- `npm run canary -- --suite smoke` without an authorization file → exited 2
  as `unavailable/unauthorized`, `modelStarts=0`.
- `npm test` after the final deterministic audit → all 23 Vitest files / 79
  tests plus the browser accessibility harness passed. The first sandboxed attempt could
  not bind `127.0.0.1`; the loopback-capable rerun passed.
- `npm run build` after the one-use authorization correction → strict
  TypeScript and Vite build passed.
- `npm run verify:zero-call` after all V-13 changes → passed with one guarded
  Codex turn site, one guarded Claude query site, one metadata-only Claude
  query site, and zero forbidden billing calls.
- `COLLAB_REAL_CANARY_AUTHORIZATION_FILE=<fresh-mode-0600-one-use-record> npm
  run canary -- --suite collab-e2e --json-out
  artifacts/v13-collab-e2e.json` → the single authorized final run exited 0
  with `passed=true`, `completed_consensus`, three starts per provider, and the
  detailed observations below. The authorization was claimed before preflight
  and cannot be replayed.
- Direct `validateCanaryEvidence(..., "V-13-collab-e2e")` validation → valid,
  no errors, evidence digest
  `6c32e2ab5ed4867c6fa069904163a7a51e9033a4b0a727247ab01cce259f98be`.

The Codex generator emits nondeterministic JSON object-key order. Raw repeated
files differed while semantic canonical hashes matched the approved snapshot.
The manifest retains the approved raw snapshot hash and adds a deterministic
recursive canonical hash for the live tripwire.

### Verification

The final aggregate,
`npm run verify:all -- --v12-result artifacts/v12-30m.json --v13-smoke-result artifacts/v13-smoke.json --v13-e2e-result artifacts/v13-collab-e2e.json --json-out artifacts/collab-acceptance.json`,
passed all 19 deterministic checks after the production ready-queue, lease,
billing-evidence, resource, migration, and real-trace corrections:

- V-1: transitions, authority matrix, hash chain, replay, idempotency.
- V-2: crash boundaries and recovery.
- V-3: causal liveness and leases (100 randomized overlap schedules).
- V-4: fail-closed billing matrix, including allowed credit presence and
  explicit existing-credit routing.
- V-5: structured limits, no invented reset.
- V-6: approvals and needs-input bridge.
- V-7: `1.0400` pass / `1.0600` fail and durable usage audit.
- V-8: exact consensus, disagreement, and budgets.
- V-9: loopback/capability/cookie/CSRF/Host/Origin/security/redaction.
- V-10: legacy read-only/import/export; zero historical mutations.
- V-11: zero serious/critical axe findings, keyboard pass, one live region,
  zero 200%-zoom overflow, 71.54 ms observed render, no SSE duplicates, restart
  restored.
- V-12 full 30-minute fake soak: 1,778 samples, service RSS max 77.83 MiB,
  tab heap max 9.54 MiB, sustained service CPU 0.04%, event-loop lag max
  9.42 ms, 46 open files, zero swap growth, degraded mode enforced, zero
  silent kills, zero model starts.
- Zero-call structural audit: one guarded Codex turn site, one guarded Claude
  model-query site, one metadata-only Claude query site, zero forbidden
  billing calls.
- Service restart recovery test passed.
- V-13 evidence: smoke and collaboration E2E both validate and pass. The
  evidence contributes 10 previously authorized starts in total: four smoke
  starts and six final-E2E starts.
- V-14: 19 deterministic checks, no failures, `v13Status=passed`, and
  `releaseReady=true`. The aggregate initiated no model call.

Acceptance artifacts:

- `artifacts/v12-30m.json` SHA-256:
  `5eef0b6bb6e0e06eebaccb170369642a9c72f03fd073ec10120a246f08e1c6bd`
- `artifacts/v13-smoke.json` SHA-256:
  `10386ce3ac09624e5cbbd804548d58d159d4c17dccbd60af93edf6220fb8b2c9`
- `artifacts/v13-collab-e2e-attempt-1.json` SHA-256:
  `909d4ec52e0d91a6f5207d5baba925991bdd610f02c12488e37205b8b4ae4d77`
- `artifacts/v13-collab-e2e.json` SHA-256:
  `869a1f640d928cbe9b8dc9234d5f58bc6fd14ec79e33595a045feec3a8676473`
- `artifacts/collab-acceptance.json` SHA-256:
  `81c365a2738d212f3028c164815e37e573957d3d2ee4d9b9ff5fabb88bfad323`

### Real V-13 observations

The user separately and explicitly authorized one bounded smoke and two
bounded collaboration-E2E attempts. Each authorization was one-use and is
consumed; no further real canary is authorized.

- Smoke passed with exactly two starts per provider (initial plus resume),
  four starts total, zero no-op invocations, complete usage, unchanged empty
  workspace, and stable identities:
  - Codex thread
    `019f9f0b-2176-7ec0-97e5-f1865f64f528`
  - Claude session
    `faed87ee-4cef-421c-b2dd-912b1dbb5165`
  - both routes before and after: `subscription_allowance`
  - evidence digest:
    `8a7301d497640749eb5515495649b4d9906ca018426d928e928204a0d533cea5`
- The original smoke serializer retained the path under the same `workspace`
  key as the verified workspace snapshot. The empty temporary workspace was
  rechecked, the source digest was retained, and the repaired artifact records
  the reason and both provenance values rather than hiding the correction.
- Collaboration E2E attempt 1 reached `completed_consensus`, verified a
  32-event hash chain, used three starts/provider, had complete usage and zero
  no-ops, and wrote the exact no-newline bytes
  `collaboration canary passed.` with SHA-256
  `c6afdde537b6c154eb98dbf7af076991f14b47253c45c5d10b1f133cb0e510bd`.
  Both billing routes remained `subscription_allowance`.
- Attempt 1 is preserved at
  `artifacts/v13-collab-e2e-attempt-1.json`, evidence digest
  `80c13bdf7343966baef7c9819442a1c2206c8210b2b77cc3ef606d690212af04`.
  It honestly reports `passed=false`: the old labels charged 194,314 of
  301,535 weighted tokens as coordination, yielding `2.8122755803434027`.
- The plan's counterfactual retains independent analysis, implementation,
  review, exact verification, and signoff as useful work. All real stages are
  therefore now `mixed`; only the canonical coordinator-owned instruction
  envelope and payload labels are conservatively charged. A regression using
  the exact six observed usage rows proves the corrected ratio is positive,
  deterministic, and at most `1.05`, while the former labels reproduce the
  exact false-failure ratio.
- The final canary now additionally hard-fails unless actual guarded model
  attempts equal starts, all starts have usage and causal ready-work records,
  wake p95 is at most five seconds, total duration is at most 30 minutes,
  forbidden billing calls are zero, Codex credit-balance evidence is complete
  and unchanged while on allowance, and Claude auth/plan/extra-usage posture
  is unchanged. These fields are required by the tamper-evident evidence
  validator, not merely printed.
- Canary authorization files are now atomically claimed with an exclusive
  mode-0600 `.consumed` marker before metadata preflight or a model start.
  Evidence files use exclusive creation. Replaying an authorization fails
  with `REAL_CANARY_AUTHORIZATION_ALREADY_CONSUMED`. Retroactive claim markers
  were installed for both already-used authorizations.
- The final collaboration E2E passed at
  `artifacts/v13-collab-e2e.json`:
  - evidence digest:
    `6c32e2ab5ed4867c6fa069904163a7a51e9033a4b0a727247ab01cce259f98be`
  - terminal outcome: `completed_consensus`
  - duration: 295,961 ms, below the 30-minute ceiling
  - three guarded attempts and three starts per provider; six starts total
  - six complete usage rows, zero no-ops, and zero forbidden billing calls
  - 38-event valid hash chain, final hash
    `3f3b5471e4057084dcde69ea23ac935aeb790d652777bcd838540569d946ac5f`
  - six causal ready-queue samples with 11 ms p95 wake latency
  - conservative overhead `1.010813026479981x`, complete coverage, and zero
    uncaused invocations
  - exact artifact SHA-256
    `c6afdde537b6c154eb98dbf7af076991f14b47253c45c5d10b1f133cb0e510bd`
  - both routes remained `subscription_allowance`; Codex reported existing
    provider-managed credits but the available balance did not change, and
    Claude remained on Max with extra usage disabled
- `validateCanaryEvidence` accepted the final artifact with no errors. The
  final V-14 aggregate accepted both V-13 evidence files and reported
  `releaseReady=true`.

### Metadata-only doctor

Latest aggregate:

- Codex: ready, ChatGPT Plus, `subscription_allowance`,
  `primary.usedPercent=76`, `credits.hasCredits=true`.
- Claude: ready, Claude Max, official Claude OAuth,
  `subscription_allowance`, `extraUsageEnabled=false`.
- Aggregate: `realProviderReady=true`.
- Model starts, purchases, auto-top-ups, and reset credits: all zero.

The first post-login doctor exposed an adapter defect rather than an account
failure: valid SDK output also contained `limits` and `spend` UI objects, which
the generic parser incorrectly treated as utilization windows. The parser now
accepts only explicit utilization windows plus normalized percentage limits,
continues to fail closed on any present incomplete window, and is covered by
live-shape regression tests.

## Deviations

- No Git base revision or clean-tree diff is possible because this supplied
  workspace is not a Git worktree. Lockfile SHA-256 stability around `npm ci`
  replaces the lockfile drift check.
- The user's newer billing policy intentionally changes the historical
  credits-present expectation. Historical artifacts were preserved.
- Playwright Chromium was downloaded project-locally to `.playwright/` after
  sandbox DNS blocked the first attempt. No global browser/service was
  installed.
- Codex app-server metadata doctor needs access to its existing local state
  database; the sandboxed attempt failed closed, and the approved unsandboxed
  metadata-only rerun passed.
- The post-login aggregate's first sandboxed rerun reached V-9 and failed only
  because the execution sandbox refused a loopback bind (`listen EPERM`).
  The approved loopback-capable rerun passed all 19 checks.
- Node reports `node:sqlite` as experimental in Node 22. The pin and schema
  version make this explicit; all WAL/crash/reopen tests pass.

## Real canary and authentication state

The bounded smoke and final collaboration E2E are complete. The final E2E
empirically exercised the corrected overhead predicate and production
ready-queue, billing-credit, duration, event-chain, usage-coverage, exact
artifact, and consensus instrumentation. The final aggregate reports
`releaseReady=true`. All short-lived authorizations are consumed, and
`verify:all` can neither authorize nor initiate V-13.

The Claude user-authentication prerequisite is complete. No API key was
requested or used. If the official OAuth session expires, the user-only
recovery remains `npm run login:claude`, followed by `npm run doctor`.

No further real provider run is required or authorized for independent review.
Any future V-13 run would require a new, separate, explicit user authorization;
the reviewer must validate the recorded evidence rather than initiate provider
model calls.

## Post-review remediation (2026-07-26)

The independent adversarial review at `docs/claude-review.md` reported twelve
findings. All twelve were actioned the same day. No V-13 canary was re-run, no
authorization was created or reused, and every change below was verified with
deterministic suites plus a metadata-only doctor; the full aggregate re-ran to
`releaseReady=true` with its JSON written to
`/private/tmp/codex-remediation-acceptance.json`. The recorded
`artifacts/collab-acceptance.json` and all V-13 artifacts remain byte-identical
historical evidence and were NOT regenerated.

### Fixed findings

- **F-1 (provider misattribution).** `real-runner.ts` no longer infers the
  failing provider from error-message substrings. Bursts and metadata
  preflights throw a typed `ProviderFailure` carrying the role from the call
  site; the limit/pause and context-exhaustion branches require it, and
  non-provider (coordinator-side) failures are no longer attributed to any
  provider. Regression: a Codex failure whose text contains a workspace path
  with "claude" now pauses Codex, not Claude
  (`real-runner-causality.test.ts`).
- **F-2 (single-run dashboard).** The UI now renders a run list/switcher with
  per-run state and pending-action counts; `/api/runs` (via
  `EventStore.listRunIds`) orders by latest event recency instead of random
  `run_id`; initial selection prefers a run awaiting user action. Covered by
  the V-11 browser harness.
- **F-3 (budget dead end).** `KernelError BUDGET_EXHAUSTED` now produces a
  dedicated `budget_exhausted` card with per-provider consumed/remaining
  counts, the active issue counts when present, both providers' latest
  recorded positions, and the five plan §3.8 actions. "Extend budget" and
  "Supply information or authority" add an audited +4 bursts per provider and
  resume (supply additionally records a `human_override` so the user's answers
  arrive through permission/needs-input cards); "Decide" records an audited
  user decision and terminates as `completed_disagreement` with both positions
  retained; "Accept disagreement" and "Cancel" behave as before. The old
  infinite "Retry collaboration" loop is gone. Honest limitation: "Supply
  information or authority" has no free-text input surface yet — it is an
  audited resume-with-extension, not a structured information channel.
- **F-4 (fabricated billing proof).** Demo/fixture preflights now mark the
  durable `BillingStatus` with `simulated: true`, prepend a
  "SIMULATED: deterministic demo fixture" proof line, and title the card
  "(demo)". The UI renders a visually distinct "Demo billing — not a proven
  route" chip and never the proven-route label. The HTTP `fixture` parameter
  on retry-preflight is gated behind the new `developmentFixtures` server
  option (off in the shipped CLI; deterministic suites opt in). V-9 now
  asserts the simulated marker; V-11 waits on the demo chip text.
- **F-5 (asserted integrity flags).** `recordUsage` no longer writes literals.
  `uncaused` is derived by resolving the claiming event's `readyWorkId`
  against the durable ready-queue row (run and role must match and the row
  must be claimed); `attributionComplete` derives from the attribution content
  actually attached; `nestedUsageComplete` derives from the provider having
  reported a structurally complete, non-zero usage object — an all-zero usage
  burst now fails the coverage gate instead of silently passing. New fixtures
  execute a burst with no claim and with a forged claim and assert the plan §8
  gate FAILS (`real-runner-causality.test.ts`); the six-burst integration test
  now verifies causal wiring end-to-end because the flags it asserts are
  derived. Honest limitation: `nestedUsageComplete` proves usage was reported,
  not that no hidden nested tree consumed usage; the canary's independent
  guard-versus-usage cross-check remains the stronger property.
- **F-7 (no interrupt on cancel).** `cancel()` now follows plan §10 in order:
  abort Claude, `turn/interrupt` the in-flight Codex turn with a bounded grace
  period (`interruptActiveTurn`, 3 s default), then close. `close()` escalates
  SIGTERM → 2 s grace → SIGKILL and waits for exit. A deterministic test
  asserts interrupt-before-close ordering. Honest deviation: termination is
  child-scoped, not process-group-scoped — the pinned spawn is not detached,
  so grandchildren of the app-server rely on its own SIGTERM handling.
- **F-9 (widened auth predicate).** The Claude gate now requires exactly
  `authMethod === "claude.ai"` as approved in plan §5.1.4, sourced solely from
  `claude auth status --json` (the `tokenSource` fallback is removed). No
  primary evidence exists that the pinned runtime emits "oauth", so the value
  was removed rather than pinned; a fixture asserts "oauth" fails closed.
- **F-10 (secondary window discarded).** The Codex adapter extracts
  `secondary` alongside `primary`; a present-but-malformed secondary window
  blocks as `billing_route_unproven`; either window at 100% (or a non-null
  `rateLimitReachedType`) triggers the existing-credits branch; both windows
  appear in the billing proof lines ("secondary window absent in provider
  response" when null). Fixture matrix added.
- **F-12 (missing evidence ledger).** The outcome view renders
  `manifest.evidenceLedger` between artifacts and the verification ledger.

### Acceptance-sensitive findings (F-6, F-8)

- **F-6 (authorization claim not required).** `validateCanaryEvidence` now
  requires `result.authorizationClaim` on every artifact, asserts
  `claimedAt < observedAt` and `claimedAt ≥ issuedAt − 60 s`, and binds
  `claim.authorizationDigest` to the evidence's authorization digest. The two
  historical artifacts that predate the claim mechanism are grandfathered by
  exact recomputed evidence digest with recorded reasons
  (`GRANDFATHERED_CLAIMLESS_EVIDENCE`):
  `8a7301d4…cea5` (v13-smoke.json) and `80c13bdf…af04`
  (v13-collab-e2e-attempt-1.json), both of whose authorizations were marked
  consumed retroactively at 15:42Z. Validation and the V-14 summary surface
  `grandfatheredClaim` explicitly. **This is weaker than the pre-review
  handoff implied:** the "one-use authorization claimed before any model work"
  property is empirically proven for exactly one of the three real runs (the
  final E2E); for the other two it rests on the recorded timeline, not on a
  pre-observation claim marker. Tests validate all three recorded artifacts
  (final strict, two grandfathered) so any byte change re-fails them.
- **F-8 (constant `C_upper`).** The attribution is bumped to `real-burst-v2`:
  in addition to the fixed framing, the runner now charges the
  coordinator-composed duplicate restatements it actually sends — the Goal
  Packet re-stated into the resumed candidate and review sessions, Codex's own
  opening re-sent to it, the manifest re-sent to its own author (Claude) at
  signoff, and the composed digest lines — so `C_upper` grows with real
  coordinator-composed content. A fixture asserts the growth. **The recorded
  V-13 traces were measured under `real-burst-v1`** (per-stage framing
  constants 599/943/847/590 bytes; `C_upper` 4,168) and can never be re-run —
  their authorizations are consumed. Re-verification therefore used the
  durable per-burst usage rows and durably recorded payloads of the final E2E
  (still on disk in the canary state database): under v2 the same trace
  charges `C_upper` 15,426 bytes and measures `1.0412236139207862x`, still
  within the 1.05 ceiling; this recomputation is pinned as an exact regression
  (`real-overhead-attribution.test.ts` +
  `test/fixtures/v13-final-e2e-recorded.json`). The reviewer's own stricter
  check ("goal charged twice more ⇒ 1.0160") verified directionally but was
  computed with a 975-byte Goal Packet estimate; the recorded Goal Packet is
  1,045 bytes, giving 1.0163. One caveat: the recorded candidate-prompt
  duplicate for Codex's opening is reconstructed from the durable packet
  exactly as `openingValue()` reconstructs it on resume; if the live model
  emitted extra fields beyond `{rationale, evidence, risks}`, the live prompt
  was marginally larger than the recomputed charge. Margin to the gate is
  3,383 charged bytes, far above any such delta.

### F-11 (advanced drawer / migration wiring) — partial, remainder deferred

Implemented: the advanced drawer now has real per-run budget controls
(`perProvider`, `perMaterialChallenge`) wired through `CreateRunInput` into
the Goal Packet and enforced budgets, and run export is wired end-to-end —
`POST /api/runs/:id/export` calls `@collab/migration`'s `exportRun` (canonical
JSONL + transcript + projection with checksums, written under the service
state directory) with an "Export run" button on completed runs.

**Deferred, plainly:** permission-preset selection (nothing downstream honors
a non-default preset yet, so exposing a control would be dishonest),
attachments, stop conditions, and the read-only legacy task-folder browser.
Legacy reading/import remains a library (`@collab/migration`) with V-10
coverage only; it is not reachable from the service or UI. These remain
approved-plan MVP surface that this build does not deliver.

### Remediation verification (commands and observed results)

All run 2026-07-26 after the changes above, with `ANTHROPIC_BASE_URL` removed
from the environment for the metadata-only doctor (it is set in the working
shell and correctly fail-closes both providers when present):

- `npm run verify:pins` → V-0 pass, pins unchanged, `modelStarts: 0`.
- `npm run build` → strict TypeScript + Vite pass.
- `npm test` → 24 files / 89 tests pass (was 23/79); every suite prints
  `modelStarts: 0`; V-11 re-passed against the new run switcher, demo chip,
  budget controls, and evidence ledger (0 serious/critical axe findings, 1
  live region, 0 reflow overflow).
- `npm run verify:zero-call` → pass; still exactly one guarded Codex turn
  site, one guarded Claude model-query site, one metadata-only Claude query,
  zero forbidden billing calls.
- `npm run verify:all -- --v12-result artifacts/v12-30m.json
  --v13-smoke-result artifacts/v13-smoke.json --v13-e2e-result
  artifacts/v13-collab-e2e.json --json-out
  /private/tmp/codex-remediation-acceptance.json` → 19/19 suites pass,
  `v13Status: passed` (smoke accepted via the recorded grandfather),
  `releaseReady: true`, `modelStarts: 10` (pre-recorded evidence only).
- Tripwires re-verified byte-identical after everything above:
  `final-plan.md`, `verification.md`, `package-lock.json`, and all five
  acceptance artifacts match the hashes recorded in this document.
- Zero provider model calls were initiated: all new tests use deterministic
  ports; the only real-adapter activity was the doctor's metadata-only
  preflight; `pgrep` found no `codex app-server` or bundled-CLI processes.

Test-fixture note: the six-burst integration fixture's engineered volumes rose
from 20,000 to 40,000 input tokens per burst — under v2 the duplicate
restatements are charged in bytes, so tiny engineered traces would sit near
the 1.05 boundary by construction; the recorded real trace is the load-bearing
regression.

## Remaining risks

- The app-server/Agent-SDK orchestration path is empirically exercised by one
  smoke trace and two collaboration traces, but those bounded traces cannot
  cover every provider response shape, live permission callback edge case, or
  future provider-version behavior.
- Claude's structured usage control API is explicitly experimental in the
  pinned SDK. Any missing/changed field blocks rather than guessing; a pinned
  upgrade requires policy revalidation.
- Codex app-server is an alpha build. Pin/schema drift blocks preflight.
- The corrected real trace passed at `1.010813026479981x` under
  `real-burst-v1` and re-verifies at `1.0412236139207862x` under the current
  `real-burst-v2` attribution; future provider output-size or prompt-shape
  changes could alter it, and v2's larger charge leaves a smaller (though
  still real) margin. The canary recomputes from durable per-burst records
  and fails if coverage is incomplete or any invocation is uncaused; the
  uncaused/coverage flags are now derived from the durable causal record
  rather than asserted, but `nestedUsageComplete` still cannot detect a
  hidden nested tree that reports usage — the canary's guard-versus-usage
  cross-check remains the stronger control.
- The one-use authorization-claim property is empirically proven
  pre-observation for the final E2E only; the smoke and first-attempt
  artifacts are accepted through an exact-digest grandfather list with
  recorded reasons (see Post-review remediation, F-6).
- Personal alpha is macOS-only, local single-user, and not distribution-ready,
  matching the approved MVP exclusions.

## Independent Claude review handoff

Review `product/` against the immutable approved plan plus the authoritative
billing delta. Start with `packages/adapters/src/policy.ts`,
`claude-adapter.ts`, `codex-client.ts`, `packages/service/src/real-runner.ts`,
`real-smoke.ts`, `tools/canary.ts`, `coordinator.ts`,
`packages/kernel/src/store.ts`, and
`artifacts/collab-acceptance.json`. Inspect both the preserved failed
`v13-collab-e2e-attempt-1.json` and passing `v13-collab-e2e.json`. Recheck
zero-call enforcement, effective auth/billing routing, one-use canary
authorization and evidence validation, restart semantics, provider permission
translations, artifact/manifest equality, event authority/replay, redaction,
loopback capability security, and real-usage attribution. Run the product
locally with fake adapters and V-0 through V-12/V-14 as useful, but do not run
V-13 or initiate any provider model call.

## Codex adversarial re-verification addendum (2026-07-26)

Codex independently re-read the planning/evidence corpus, challenged every
remediation finding F-1 through F-12, reconstructed the final real E2E from a
quiescent copied SQLite database, and ran the complete deterministic and
metadata-only battery without starting a provider model turn. The detailed
report is `docs/codex-verification.md`.

Five received remediations required further surgical correction:

- **F-2:** the durable history implementation was sound, but an SSE/create
  race duplicated run entries in the UI. Create-response handling now
  upserts by `runId`; multi-run and action-card restoration are proven across
  service restart.
- **F-3:** supply/decide actions now require structured user text. Supplied
  information is redacted, durably audited, inserted into resumed provider
  prompts, and conservatively charged in overhead attribution; decisions
  retain their actual user text.
- **F-5:** usage causality now binds the stored claim to the exact durable
  ready-work ID, run, role, trigger event, and wake reason. Swapped-trigger
  and swapped-reason forgeries fail.
- **F-6:** strict authorization claims now require absolute marker/evidence
  paths as well as bound digest and timestamp. The test matrix covers missing
  subfields, harmless serialization changes, semantic tampering, and failed
  E2E relabeling.
- **F-7:** Codex now runs in a detached process group; termination signals the
  group, force-kill is ordered after grace and followed by confirmed exit,
  and the cancellation API waits for run reconciliation before terminalizing.
  An uncertain effect remains nonterminal and visible.

F-1, F-4, F-8, F-9, F-10, and F-12 withstand the requested adversarial
challenges. The durable final-E2E rows independently remeasure at
`T=389,629`, `C_upper=15,426`, ratio `1.0412236139207862` under
`real-burst-v2`.

F-11 remains partial: budgets and export are reachable, but the approved MVP
still lacks the read-only legacy browser plus permission-preset,
stop-condition, attachment, and resource-mode controls. The aggregate now
records these gaps as `mvpSurface.passed=false`; consequently the new required
aggregate at `/private/tmp/codex-reverify-acceptance.json` reports all 19
suites passed and V-13 evidence passed, but `releaseReady=false`. This
supersedes the earlier unqualified `releaseReady=true` statement in the
remediation verification section above.

Post-verification tripwires remain byte-identical for both protected planning
documents, `package-lock.json`, and all five protected acceptance artifacts.
The original `/private/tmp/codex-remediation-acceptance.json` was not
overwritten.

## Claude third-pass addendum (2026-07-26, after Codex re-verification)

Claude adversarially reviewed every file Codex changed, independently re-ran
the complete battery, and endorses Codex's five additional repairs and its
`releaseReady=false` verdict (the `mvpSurface` blocker is a deliberate,
fail-safe release gate; its gap list is a hand-maintained constant that must
be updated when the F-11 surfaces ship). Two defects introduced or exposed by
the re-verification pass were found and fixed:

- **Service-crash path from the hardened kill contract.** Codex's `close()`
  correctly throws `CODEX_PROCESS_EXIT_UNCONFIRMED` when a force-killed
  app-server never confirms exit, but `runReal` — invoked fire-and-forget
  from four call sites — had no catch, so that throw would have become an
  unhandled promise rejection and killed the whole service. `runReal` now
  contains cleanup failures and surfaces them as a durable
  "Provider shutdown did not confirm cleanly" card
  (`coordinator.ts`; regression in `real-runner-causality.test.ts`).
- **Cancel dead-end on shipped uncertain-effect cards.** Codex's guard
  correctly refuses to terminalize (and thereby wipe) a pending
  reconciliation card, but the shipped uncertain-effect cards offer
  "Cancel", which had become a silent no-op — the same dead-end class as
  F-3. Cancel chosen on the reconciliation card itself is now recorded as an
  audited `human_override`
  (`acknowledge_uncertain_effect_and_cancel`) followed by `cancelled`;
  Cancel from any other card while a reconciliation is pending still
  preserves the card (Codex's semantics, unchanged and regression-covered).

After these fixes: `npm run build` pass; `npm test` 99 Vitest tests plus the
V-11 browser harness pass (every suite `modelStarts: 0`); `verify:zero-call`
unchanged at 1/1/1/0; the full aggregate passes 19/19 with
`v13Status: passed` and `releaseReady: false` at
`/private/tmp/claude-pass3-acceptance.json` (Codex's
`codex-reverify-acceptance.json` and the original remediation aggregate were
left untouched). All eight tripwire/artifact hashes re-verified
byte-identical; zero provider processes; the doctor remained metadata-only.

## Codex F-11 release-blocker closure (2026-07-26)

Codex verified both Claude third-pass coordinator corrections before changing
the MVP surface. The uncertain-effect card's own Cancel action is consistent
with plan §§7/10: it is an explicit user resolution, records
`acknowledge_uncertain_effect_and_cancel`, and only then cancels; Cancel from
another card still cannot erase a pending reconciliation card.

The `runReal` containment was present at all four fire-and-forget call sites,
but one terminal-order edge remained: consensus was persisted before
`codex.close()`, so an unconfirmed exit after apparent success was caught but
could not raise the promised nonterminal card. Completion is now committed
only after provider cleanup confirms. A regression asserts close observes a
nonterminal run; the existing failure-card regression and all four shared
`runReal` entry points remain covered.

F-11 is now implemented without decorative controls:

- A legacy browser lists immediate task folders only beneath an explicitly
  configured `CollabServerOptions.legacyTasksRoot` (shipped CLI:
  `--legacy-tasks-root PATH`). It is absent when unset. List/detail routes are
  session-gated; child IDs are realpath-contained; symlink escape and traversal
  fail closed; the UI renders goal, state, notes, transcript, final plan, and
  hashed file inventory as escaped text. Browser regression snapshots prove
  historical bytes do not change.
- Attachments are workspace-contained regular files captured in the immutable
  Goal Packet as relative path, SHA-256, byte size, and media type. Providers
  receive those references through the packet; attachment bytes are not copied
  into prompts or the event store.
- The read-only preset removes writable roots, uses Codex's `read-only`
  sandbox, denies non-read approval requests, and starts Claude with mutation
  tools disallowed and `dontAsk`; the default preset retains the existing
  ask-before-mutation path.
- The maximum-duration stop begins only after successful preflight. At expiry
  it aborts Claude, interrupts and closes Codex, preserves any uncertain-effect
  reconciliation, and records terminal cancellation only after cleanup
  confirms.
- Serialized resource mode runs parallel-capable opening/signoff provider
  bursts one at a time; automatic mode retains parallel execution unless the
  resource governor requires serialization.

Verification on the final source state: build pass; 104 Vitest tests + V-11
pass with zero current model starts; V-11 reports zero serious/critical
accessibility findings, zero reflow overflow, escaped hostile legacy markup,
and all advanced values persisted; zero-call audit remains 1/1/1/0. The
metadata-only aggregate at `/private/tmp/codex-f11-acceptance.json` passes
19/19 with `mvpSurface.passed=true`, no blocking gaps, preserved
`v13Status=passed`, and `releaseReady=true`. Its `modelStarts: 10` is preserved
V-13 evidence only; the current doctor and every executed suite report zero.

## Interactive-resource coordination (2026-07-27)

Codex and Claude can no longer operate the same interactive resource
concurrently. An exclusive interactive-resource layer is integrated into the
existing deterministic `LeaseManager` (`packages/kernel/src/leases.ts`) and
enforced at the runner's tool gate (`packages/service/src/real-runner.ts`).

### Semantics

- **Resource identities** are canonical ids derived only from trusted
  product/runtime state: `interactive:computer_use` (one machine-global
  resource), `interactive:browser:global` (the fail-safe for every
  unverifiable browser identity), `interactive:browser:profile:<id>`
  (exclusive per trusted signed-in profile/session), and
  `interactive:browser:isolated:<id>` (product-created contexts whose
  isolation the browser controller mechanically proved). The conflict matrix:
  same id is exclusive; `browser:global` conflicts with every browser
  identity; distinct proven identities may run concurrently; computer use and
  browser are distinct classes.
- **Classification is transport-derived.** The resource CLASS comes from the
  typed tool name / JSON-RPC method / command text the product observes
  (`mcp__computer-use__*`, `computer`, `mcp__claude-in-chrome__*`,
  browser-driver and browser-launch command patterns, `cliclick`,
  `osascript … System Events`); over-matching is safe because it serializes.
  Browser IDENTITY comes solely from an optional
  `InteractiveResourceRegistry` port; ids found in model-supplied tool input
  are never trusted, and a registry answer without a verifiable id degrades
  to the global browser resource.
- **Permission ≠ lease.** The runner's gate (`gateCodexToolRequest` /
  `gateClaudeToolRequest`) sits between the permission decision and tool
  execution: an approved request still acquires every declared path and
  interactive-resource lease — waiting if the peer holds it — before the
  approval reaches the provider. Waiting emits `lease_waiting` with holder,
  reason, and the canonical resource ids; the projection/UI render
  `waiting_lease` naming the exclusive resource with no invented ETA; waits
  launch no model call and consume no useful-work burst (`resumed` events
  carry `modelWake: false`, `chargeBudget: false`).
- **Atomicity and deadlock.** A multi-resource request is granted atomically
  in one acquisition over lexically sorted canonical ids, so claim order
  cannot deadlock. Mid-burst escalation (a burst adding a resource it does
  not hold) detects the two-party cycle — the blocking holder itself parked
  on a resource this burst holds — and fails closed with a typed
  `INTERACTIVE_LEASE_DEADLOCK` error that the gate converts into an honest
  tool denial; the peer's release then unblocks the waiter (liveness proven
  in tests).
- **Hold and reconciliation.** Leases are held across the complete provider
  burst and released only at its completion boundary. A failed burst, stop,
  cancellation, or crash never releases an interactive lease blindly: the
  lease is marked uncertain, an `uncertain_effect` card names the resource
  ("may have left an interactive resource in an uncertain state"), the
  waiting provider stays blocked, and service-restart recovery surfaces the
  outstanding lease as an interactive-resource reconciliation card.
  User-acknowledged cancellation remains the audited
  `acknowledge_uncertain_effect_and_cancel` flow.

### What can actually run concurrently today — honest limitation

**Nothing interactive.** No browser controller capable of creating and
mechanically proving isolated contexts is installed in this product, and no
`InteractiveResourceRegistry` is wired in production, so every browser claim
fails safe to the single global browser resource: all browser work
serializes, Computer Use serializes machine-globally, and browser and
computer-use classes are the only concurrency between interactive claims.
There is deliberately no session selector in the UI — a selector without a
proving controller would be decorative. The isolated-context and
trusted-profile concurrency paths are fully implemented and regression-tested
through a registry double simulating a proving controller; they become
reachable in production only when a real controller registers and verifies
the identities it creates.

### Verification (2026-07-27)

- Kernel conflict-matrix and atomic multi-resource unit tests added to V-3
  (`packages/kernel/test/leases.test.ts`); a resource-only lease takes no
  path lease, so workspace mutations proceed alongside interactive holds.
- New `packages/service/test/real-runner-interactive-leases.test.ts`
  (12 tests): simultaneous Computer Use observes max concurrency 1;
  same trusted profile serializes across two RUNS; two controller-verified
  isolated contexts run concurrently with zero waiting events; forged or
  unverifiable ids serialize globally, including against an isolated
  context; `waiting_lease` carries holder/resource/reason; waiting produces
  zero `work_claimed` events and zero budget consumption; an approved
  permission still blocks on the lease and a denied one never acquires;
  reversed-order multi-resource claims serialize atomically without
  deadlock; the two-party escalation cycle is broken by an honest denial
  with liveness preserved; a failed burst retains the uncertain lease,
  raises the resource card, and never wakes the waiter; restart recovery
  surfaces the interactive reconciliation card.
- Full battery on the final state: `verify:pins` pass; strict build pass;
  `npm test` **118 Vitest tests + V-11** pass (every suite
  `modelStarts: 0`; V-11 unchanged at zero serious/critical findings, one
  live region); `verify:zero-call` unchanged (1/1/1/0); aggregate 19/19 at
  `/private/tmp/claude-interactive-leases-acceptance.json` with
  `v13Status: passed`, `releaseReady: true`, `modelStarts: 10`
  (pre-recorded evidence only). All eight tripwire hashes byte-identical;
  zero provider processes; the doctor stayed metadata-only. No V-13 was run
  and no authorization was created or reused.

### Files changed

`packages/kernel/src/leases.ts` (claims, canonical ids, conflict matrix,
atomic resource acquisition, resource-only requests take no path lease),
`packages/kernel/src/projection.ts` and `packages/contracts/src/index.ts`
(`waitingLease.resources`), `packages/service/src/real-runner.ts`
(registry port, transport-derived classification, gate methods, multi-lease
burst holding with escalation and deadlock break, resource-aware uncertain
cards), `packages/service/src/coordinator.ts` (interactive-aware recovery
card), `packages/ui/src/app.tsx` (exclusive-resource waiting line);
tests: `packages/kernel/test/leases.test.ts`,
`packages/service/test/real-runner-leases.test.ts` (private-API shape),
new `packages/service/test/real-runner-interactive-leases.test.ts`.

## Two-arm worker-overhead gate and advisory supervisor (2026-07-27)

Implemented per `docs/codex-advisor-analysis.md` (controlling design; where it
conflicts, it supersedes `docs/advisor-and-gate-proposal.md`). Part A landed
and passed its focused regressions before Part B began. No V-13 was run, no
canary authorization was created or reused, and no provider model turn was
initiated at any point in this session; the only real-provider activity was
metadata-only (pins, doctor, and one model-catalog read per provider for the
deterministic profile pin). The lockfile is byte-identical.

### Part A — overhead-gate-v2

- `packages/kernel/src/overhead.ts` now reports the honest breakdown while
  preserving the compatibility scalar: `workerBurstCount` (unique worker
  invocations), `coordinationTokenUpper` (full token charges for
  coordination-only and unattributed mixed calls), `mixedCoordinatorBytes`
  (UTF-8 bytes of attributable coordinator-owned mixed-call content),
  `coordinationUpper = tokens + bytes` (unchanged compatibility value),
  `absoluteAllowanceBytes`, `absoluteEligible`, `passedBy`, and
  `gateVersion: "overhead-gate-v2"`.
- The gate is exactly: coverage complete ∧ zero uncaused invocations ∧
  `S_lower > 0` ∧ (ratio ≤ 1.05 ∨ (absolute-eligible ∧ token coordination
  charge = 0 ∧ mixed bytes ≤ 8,192 × worker bursts)). A pure coordination
  call, an unattributed whole-call charge, or missing usage is
  absolute-ineligible; `S_lower ≤ 0` can never pass either arm; adviser usage
  never enters the worker total, lower bound, ratio, or burst count.
- The allowance is pinned in `pin-manifest.json` (`overheadGate`):
  real-burst-v2 reference, 15,426 charged bytes over 6 worker bursts,
  multiplier 3, next-power-of-two rounding, result 8,192, and the reference
  fixture SHA-256. **Correction recorded plainly:** the analysis document's
  prompt lists the fixture digest as `627534…b9bcffec1f…f35a7`, a 63-hex-char
  string that cannot be a SHA-256; the actual digest of
  `packages/service/test/fixtures/v13-final-e2e-recorded.json` is
  `627534eefa05530589e8685b51fd05b9bcffefc1f5965f80096b07a8b54f35a7`
  (one dropped `f` in the analysis). The real computed value is pinned, and
  `verify:pins` now enforces fixture bytes, derivation arithmetic, and the
  kernel constant against the manifest.
- Worker usage rows are invocation-unique: the burst key embeds the durable
  ready-work id, rows carry `ready_work_id`/`claim_event_id`/
  `trigger_event_id`, identical duplicate delivery is idempotent, a
  different record under an existing key is rejected, and retries/recovery
  claim new ready items and record distinct rows with distinct causal
  bindings. Nothing overwrites an earlier invocation.
- Live visibility is provisional: the dashboard chip says "Worker-loop
  overhead", failing styling on an active run is dashed/provisional and
  clears when a later report passes, and no ActionCard, interruption, or
  state change ever results. At stable boundaries (terminal consensus,
  user-terminal disagreement, declared disagreement, budget-exhaustion
  waiting_user, cancellation after cleanup) one typed non-blocking
  `overhead_gate_breached` system notice is persisted per boundary kind if
  the report still fails — never `needs_input`, never a run-state change.
  This deviation from the plan's single 1.05 arm is recorded here as the
  authorized implementation deviation; recorded V-13 artifact bytes and
  claims are untouched, and the recorded final trace still measures total
  389,629, compatibility C_upper 15,426, ratio 1.0412236139207862, passed by
  the ratio arm.

### Part B — advisory supervisor (off by default, zero authority)

- Immutable per-run `GoalPacket.advisor` config: enabled, provider (Claude
  default), effort high/medium, two reactive wake units plus one reserved
  non-cancel retrospective unit; extensions are positive-integer, audited
  `advisor_budget_extended` user events.
- `ReadyRole = ProviderRole | "advisor"` exists only in ready-queue
  contracts. Worker `enqueue`/`claim` mechanically reject the adviser role;
  `enqueueAdvisor`/`claimAdvisor` are separate lanes; no adviser value ever
  indexes worker, billing, budget, packet, or signoff maps. `ProviderRole`,
  `Actor`, packets, manifests, consensus, and terminal core state are
  unchanged, and every core event type rejects an adviser pseudo-actor.
- Schema v2: `usage_records` causal-binding columns, `ready_work`
  completion fields (`completed_at`, `outcome`) for explicit no-replay
  recovery, and the kernel-owned hash-linked adviser sidecar
  (`advisor_ledger` for wake claim/outcome/observation/failure,
  `advisor_usage` unique per wake id, `advisor_epochs` for durable
  deadlines). `EventStore` now refuses version mismatches before executing
  any pragma or DDL, so a refused open leaves the database byte-identical
  (this also fixed a latent defect where a refused open mutated the file).
  The operator migration is `collab migrate-db`
  (`migrateCollabDatabaseV1ToV2`): quiesced-WAL check, verified byte
  backup, transactional apply, verified rollback on failure, newer-schema
  refusal — regression-tested against a hand-built true-v1 database with
  legacy rows preserved semantically unchanged.
- `ModelStartGuard` accepts `advisor_observation` authorizations only with
  an exact adviser start context (run, provider, ready-work id, trigger
  event id, purpose) and consumes each authorization id once; worker/adviser
  cross-use, every binding mismatch, and replay fail before a start counts.
- Adapter `executionProfile: "advisor"` reuses the two existing guarded
  model-bearing sites unchanged: Codex `runBurst` adds exact `model`,
  `effort`, and `outputSchema` to the one guarded `turn/start`, runs
  read-only with approvalPolicy `never` and decline-all server responses,
  verifies the thread-selected model, and fails closed on a
  `model/rerouted` notification; Claude `startBurst` runs `tools: []`,
  `permissionMode: "dontAsk"`, no MCP/skills/subagents/web, `maxTurns: 1`,
  no `canUseTool` path, exact `model`/`effort`, and interrupts on a
  `system/init` model mismatch. Adviser execution is rooted in
  `<state-root>/runs/<run>/advisor/runtime`, never the user workspace, with
  a bounded wake timeout and no lease route.
- Model profile pinned through metadata only (observed 2026-07-27, recorded
  in `pin-manifest.json` `advisor`): Codex `model/list` non-hidden
  `isDefault: true` row → canonical `gpt-5.6-sol`, efforts high/medium
  advertised; Claude `supportedModels()` `value: "default"` row →
  `resolvedModel` canonical `claude-opus-5[1m]`, efforts high/medium
  advertised. Both providers satisfy the deterministic default-row rule, so
  both are available; the catalog is re-read and the exact row plus chosen
  effort re-verified before every wake, and drift/reroute/aliases/fallback/
  nonstandard tier all fail the wake closed without touching workers.
- Typed, debounced triggers, each a durable condition instance (the
  `advisor_trigger` core system event's idempotency key, or the
  user-authored `advisor_requested` event, or the terminal `completed`
  event for the retrospective): repeated same-provider/stage/code failure
  (fires on the second, reset by success), per-state durable stalls
  (working 10 m from last trusted activity, waiting_lease 10 m,
  recovering/replacing_context 2 m; user/permission/limit/preflight,
  waiting-handoff, signed, and terminal waits excluded), declared
  disagreement, typed budget-exhaustion card, trusted unknown-browser-
  identity degradation (once per burst episode, model-supplied ids never
  qualify), stable overhead breach (Part A notice), resource degradation
  persisted 5 m (durable epoch; not claimable until heavy work is admitted
  again), user request, and the non-cancel terminal retrospective.
  Cancellation starts no model call and writes a deterministic
  retrospective skip record.
- Runtime activity: provider notification/message callbacks persist
  coalesced text-free `runtime_activity` events at most once per 30 s per
  provider; stall epochs/deadlines are durable (event log plus sidecar
  epochs) and rehydrated into `setTimeout` timers on restart; there is no
  polling loop and no text parsing.
- Scheduling: adviser work is low priority — enqueued any time but claimed
  only at a provider-safe boundary, never while a worker burst is active on
  the selected provider and never while the governor refuses heavy work. A
  failed metadata preflight consumes no wake unit; a guarded start consumes
  one; the retrospective unit is reserved in both directions. A claimed
  wake with an unknown crash outcome is failed visibly
  (`ADVISOR_WAKE_OUTCOME_UNKNOWN_AFTER_RESTART`) and never replayed;
  unclaimed ready work survives restart.
- Input/output: fixed product-authored framing plus a typed, redacted,
  bounded JSON delta (secrets/auth/capability keys stripped, workspace path
  masked, per-event and per-string bounds, omissions counted and
  digest-recorded) and an allowlisted projection summary. Both providers
  receive the same JSON Schema (Codex via the newly exposed
  `turn/start.outputSchema`, Claude via `outputFormat: json_schema`) and
  the service revalidates independently, all-or-nothing; malformed output
  is one adviser failure and applies nothing. Output may carry only fixed
  non-permission recommendation codes; the service authors the displayed
  copy; notes are never delivered to workers.
- Files: mode-0600, symlink-safe (O_NOFOLLOW), atomically
  replaced/created files only under `<state-root>/runs/<validated-run-id>/
  advisor` — hash-linked `observations.jsonl`, atomic `notes.md`,
  exclusive-once `retrospective.md` (or a deterministic skip record) — all
  headed with the fixed untrusted-model-output warning and included with
  checksums in `collab export` without following links.
- Accounting: `workerOverhead` (the Part A gate), full `advisorUsage`
  bucket by provider with wake counts, coverage, and uncaused checks,
  `combinedModelUsage`, and an informational `combinedCoordinationRatio`
  that is never a pass/fail predicate. The global coverage and
  zero-uncaused checks span both buckets; adviser tokens/calls cannot
  change the worker ratio, `passedBy`, or the absolute allowance. UI copy
  says "worker-loop overhead" and the adviser lane shows full adviser
  usage.
- UI: an adviser lane hidden when disabled, wake/trigger/budget/model
  display, escaped note file listings, an "Ask the adviser" button
  (user-authored event, budget-limited, disabled on terminal runs), and
  non-blocking adviser cards. V-11 covers the lane: zero serious/critical
  axe findings, keyboard focus on the Ask button, exactly one live region,
  and zero 200%-zoom overflow. The V-11 harness asserts the button without
  clicking it so the deterministic browser suite performs no provider
  metadata work; the click path is covered by the deterministic
  adviser-service suite.
- Canary evidence: `validateCanaryEvidence` accepts an optional `advisor`
  bucket — preserved artifacts remain valid untouched and report an absent
  bucket; a future adviser-enabled canary must prove the selected profile,
  per-wake trigger/claim/authorization/usage binding, usage coverage, zero
  uncaused wakes, and a zero no-op wake count. No such canary was run.
- `verify:zero-call` is structurally strengthened: per-file symbol
  allowlists for the guarded sites, SDK import confinement, and rejection
  of aliasing, computed properties, rebinding, dynamic import/require, and
  method-name fragmentation — while still reporting exactly one guarded
  Codex turn site, one guarded Claude model query, one metadata-only
  Claude query, and zero forbidden billing calls.

### Commands and observed results (2026-07-27)

- Baseline before any edit: all eight tripwire hashes matched
  `docs/remediation-report.md`; `verify:zero-call` passed 1/1/1/0.
- `npm run verify:pins` → V-0 pass, pins unchanged plus the new
  overhead-gate pin enforced, `collabdSchemaVersion: 2`, modelStarts 0.
- `npm run build` → strict TypeScript + Vite pass (UI bundle regenerated).
- `npm test` → 171 Vitest tests pass (adapters 32, kernel 44, security 5,
  migration 4, service 86) plus the V-11 browser harness
  (`advisorLaneCovered: true`); every suite prints modelStarts 0.
- `npm run verify:zero-call` → pass, exactly 1/1/1/0 with the structural
  allowlist over 22 production files.
- `env -u ANTHROPIC_BASE_URL npm run verify:all -- --v12-result
  artifacts/v12-30m.json --v13-smoke-result artifacts/v13-smoke.json
  --v13-e2e-result artifacts/v13-collab-e2e.json --json-out
  /private/tmp/codex-advisor-gate-acceptance.json` → 22/22 suites pass
  (the battery gained V-4-advisor-guard, V-4-codex-client, and
  V-7-advisor-sidecar), `v13Status: passed`, `mvpSurface.passed: true`,
  `releaseReady: true`, aggregate `modelStarts: 10` — preserved V-13
  evidence only; the doctor and every executed suite reported zero current
  model starts, with both providers ready on `subscription_allowance`.
- All eight tripwire hashes re-verified byte-identical after all work.
- `pgrep` shows no `app-server --listen stdio://` or bundled-CLI process
  from this session; the ChatGPT desktop app's own long-running processes
  were left untouched.

### Honest limitations

- The adviser has never run against a real provider: every model-bearing
  adviser test uses deterministic fake ports. The real-path drift checks
  (Claude `system/init` model string for `claude-opus-5[1m]`, Codex thread
  model field shape) fail closed by design if a live shape differs; a
  future separately authorized adviser canary is the empirical check.
- The adviser's one-use authorization set and 30-second activity coalescing
  are per-process; durable one-use enforcement comes from the sidecar wake
  pipeline (one authorization per wake row), not the guard alone.
- In-memory failure streaks and browser-degradation debounce reset on
  service restart (conservatively requiring a fresh pair of failures);
  stall and degradation epochs are durable and rehydrated.
- The worker→adviser deference is one-directional as designed: adviser
  claims defer to active worker bursts, and a worker burst starting during
  an in-flight adviser wake is not blocked by it.
- The combined model-usage ratio may exceed 1.05 on adviser-enabled runs;
  the 1.05 promise is explicitly the worker-loop gate. Adviser-disabled
  runs keep the historical guarantee unchanged.

### Post-handoff hardening verified on the final source state (2026-07-27)

The section above was written before a further hardening pass landed in the
same working tree. The shipped code is stricter than that description in six
ways, each re-verified here against the final source:

- **Provider exclusion is a gate, not a probe.** The earlier
  `workerBurstProbe` was check-then-act: a worker burst could start between
  the probe and the adviser start. `advisor/execution-gate.ts` replaces it
  with a provider-scoped readers/writer gate — workers may overlap each
  other, an adviser wake is exclusive with every worker burst on the same
  provider, waiting workers are admitted with priority (queued advisory work
  cannot starve collaboration work), and slots are reserved before any
  promise resolves so a competing acquisition in the next microtask still
  observes the provider as busy. `executeProviderBurst` acquires and releases
  it around every worker burst; `pump` acquires it before claiming and
  releases it in `finally`.
- **The system framing is a real system/developer instruction.** It is no
  longer concatenated with untrusted data in the user turn: Claude receives
  it via `Options.systemPrompt` and Codex via
  `thread/start`/`thread/resume` `developerInstructions` (both present in the
  pinned surfaces — `developerInstructions` and `config` are valid
  ThreadStart/ThreadResume properties in the pinned v2 schema, and are
  deliberately *not* sent on `turn/start`, which does not define them). The
  advisor profile now fails closed without a system prompt.
- **Cited event ids must be real.** `validateAdvisorOutput` takes the set of
  event ids at or before the wake's `observedThroughSeq` and rejects any
  observation citing an id outside it; `eventIds` must also be non-empty. The
  earlier version accepted arbitrary strings, which would have made
  "findings linked to durable event ids" an unverified claim.
- **An adviser authorization binds exactly one provider.** The guard now
  rejects an `advisor_observation` authorization listing both providers, so
  it cannot be presented on the provider it was not issued for.
- **Codex adviser tool isolation is explicit.** The advisor thread disables
  MCP servers (discovered-server overrides), sets `web_search: "disabled"`,
  and disables the configured feature set, in addition to the read-only
  sandbox, `approvalPolicy: "never"`, and decline-all server responses. The
  profile fails closed if isolation is not configured.
- **Trigger resolution fails closed.** `triggerSummary` no longer degrades an
  unresolvable trigger to `user_request`; a missing trigger event, a
  sequence mismatch, a non-system actor, or an invalid/kind-mismatched
  payload each raise and become a visible adviser failure rather than a
  mislabeled, mis-budgeted wake.

Verification on this final state: `npx tsc --noEmit` clean; `npm run build`
pass; **183 Vitest tests + V-11 pass** (adapters 34, kernel 44, security 5,
migration 4, service 96; every suite `modelStarts: 0`; V-11 reports zero
serious/critical findings, one live region, zero reflow overflow,
`advisorLaneCovered: true`); `verify:zero-call` still exactly 1 guarded Codex
turn / 1 guarded Claude model query / 1 metadata-only Claude query / 0
forbidden billing calls, structurally enforced across 23 production files;
aggregate 22/22 at `/private/tmp/claude-advisor-final-acceptance.json` with
`v13Status: passed`, `mvpSurface.passed: true`, `releaseReady: true`, and
`modelStarts: 10` (preserved V-13 evidence only — the doctor and every
executed suite reported zero current model starts). All eight tripwire hashes
re-verified byte-identical. No V-13 was run, no authorization was created or
reused, and no provider model turn was initiated in this session.

Process note: two `codex app-server --listen stdio://` processes were alive at
the end of this verification (PIDs 82500, 83155). Neither is a leak from this
session — both trace their ancestry to the ChatGPT desktop application
(`ChatGPT.app` → its own `app-server` → `node_repl` / `npm start` →
`packages/service/src/cli.ts`), i.e. a peer-driven `collab` service and the
desktop app's own tooling. They were deliberately left running rather than
terminated, per the standing rule against killing unrelated pre-existing user
processes.
