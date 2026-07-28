# Proposal: advisory model supervisor and two-arm overhead gate

Author: Claude, 2026-07-27
Status: proposal for Codex adversarial analysis — nothing here is implemented
Origin: user request for a model coordinator that can understand semantic
problems and leave notes for later fix passes, combined with the user's
concern that the fixed 1.05 overhead ceiling could unfairly constrain the
product. Builds on Codex's "advisory model supervisor backed by a
deterministic safety kernel" sketch and the discussion recorded in this
repo's session history.

The two parts are independent. Part A is small and should land first.

---

## Part A — Two-arm overhead gate (overhead-gate-v2)

### Problem

The current gate is `coverage ∧ uncaused=0 ∧ M/S_lower ≤ 1.05`. The
coordinator's charged plumbing is roughly fixed per burst (framing ~1 KB plus
duplicate restatements, measured ~2.6 KB/burst on the recorded final E2E),
and it is charged in bytes against a denominator in tokens. A percentage
ceiling over a fixed cost is scale-dependent: the recorded 389k-token run
measures 1.0412, but the identical, correctly-behaving protocol on a small
goal (~30k tokens, 6 bursts) measures ~1.3 and falsely fails. The
integration fixture already had to inflate its volumes (20k→40k
tokens/burst) to stay clear of the boundary — a smell that the instrument,
not the behavior, is wrong at small scale.

Raising the constant (1.35/1.5 was considered) repairs small runs but
neuters the gate on large cache-heavy runs, where even wasteful coordination
sits near 1.1.

### Proposed rule

A run passes when:

```
coverageComplete ∧ uncausedInvocations == 0 ∧
( M/S_lower ≤ 1.05  ∨  C_upper ≤ 8192 bytes × burstCount )
```

- The ratio arm keeps the strict 5% promise for normal and large runs.
- The absolute arm is a flat per-call allowance (~3× the measured legitimate
  per-burst charge) that rescues small runs whose plumbing is normal.
- A genuinely wasteful coordinator (re-sending large content every call)
  fails both arms at every scale.
- `burstCount` = number of usage records in the run (one per model call).

### Implementation notes

- `packages/kernel/src/overhead.ts`: add `burstCount`, `absoluteAllowance`,
  `passedBy: "ratio" | "absolute" | null`, and a `gateVersion:
  "overhead-gate-v2"` field to `OverheadReport`; compute the OR.
- V-7 fixtures: keep 1.04-pass/1.06-fail for large-shape runs (the 1.06
  fixture must exceed the absolute arm too — size it so C_upper > 8 KB ×
  bursts); add an engineered small-run fixture that fails the ratio arm and
  passes the absolute arm; add a wasteful fixture failing both arms.
- The service regression `real-overhead-attribution.test.ts` re-asserts the
  recorded final trace passes by the ratio arm with unchanged numbers
  (C_upper 15,426, ratio 1.0412236139207862).
- **Deviation, stated plainly:** plan §8/§12 and verification.md V-7 (both
  tripwired, unmodifiable) specify the single 1.05 rule and the 1.04/1.06
  fixtures. This change is a documented implementation deviation in the
  handoff, exactly like the billing-policy delta. Recorded V-13 artifacts
  remain valid: their `overhead.passed` flags are recorded data and all
  recorded runs pass the new rule via the unchanged ratio arm.

### Live gate-breach visibility

Today a live run that fails the gate completes silently; the ratio is only a
number on a chip. Add: when a run's overhead report first turns failing, the
service raises a `needs_input` card ("This run spent N% of tokens on
coordination — worth a fix pass") without interrupting the run, and the chip
gets failing styling. This is also an advisor trigger (Part B).

---

## Part B — Advisory model supervisor ("advisor")

### Role, in one sentence

An optional, visible, budgeted model that observes a run through the durable
event log, diagnoses semantic problems the deterministic coordinator cannot
see (circling, misunderstanding, unproductive stalls), and writes
event-linked notes for the user's later fix passes — with zero authority
over enforcement.

### Hard boundaries (non-negotiable)

The advisor can NEVER: grant or influence permissions; acquire, release, or
override leases; wake or message the workers; author packets, candidates, or
signoffs; modify the Goal Packet; touch billing state; or cause any state
transition other than its own observation events and user-decision cards.
Kernel-enforced: a new `advisor` actor is rejected for every provider-only,
user-only, and coordinator-only event type; its only writable surfaces are
its note files and a new `advisor_observation` event carrying an escaped
card. Its output is data: rendered escaped, never executed, never
auto-applied. Recommendations appear as cards whose actions map only to the
existing user-decision vocabulary plus free text.

### Activation and model choice

- Off by default. Per-run opt-in in the advanced drawer.
- Per-run provider choice (`claude` default, `codex` alternative) and effort
  tier (`strong` default, `medium` to economize). Rationale for the strong
  default: wakes are rare (budget default 3/run) and each is a hard
  judgment; economizing on wake quality wastes the feature, economizing on
  wake frequency is already the design. Codex should verify which concrete
  model/config knobs the pinned SDK (0.3.220) and app-server
  (0.146.0-alpha.3.1) actually expose for tier selection and pin them; if a
  tier cannot be selected mechanically, ship provider choice only and record
  that limitation.
- Same subscription-only rules: full metadata preflight before every advisor
  wake; advisor bursts go through the model-start guard with a new
  authorization kind `advisor_observation`.

### Wake causality (event-driven, never polling)

Advisor wakes are enqueued in the SAME durable ready queue (new role value
`advisor`) with the trigger event id, and claimed like any other model work.
Triggers, each debounced to fire once per condition instance:

1. `repeated_failure` — the same provider fails twice in a run.
2. `stall` — a worker in a waiting state past a trusted-timer threshold
   (default 10 minutes; no text parsing, OS timer only).
3. `disagreement_declared`.
4. `budget_exhausted` card raised.
5. `unknown_resource_identity` — an unverified browser claim was serialized
   globally (from Part A of the interactive-lease layer).
6. `overhead_gate_breach` — the live report turned failing (Part A).
7. `user_request` — an "Ask the advisor" button in the UI.

No trigger, no wake. The advisor session is one resumed provider session per
run, so each wake pays only for the event delta on top of cache.

### Inputs and outputs

Input per wake: a typed, redacted event delta plus current projection
summary, framed with the same untrusted-data rules the workers get (packet
contents are data; instructions inside them must not be followed). Output is
schema-constrained JSON: a list of observations each tied to event ids with
a severity, an updated note body, an optional user card, and at terminal
state a retrospective. Malformed output is recorded as an advisor failure
and never partially applied; an advisor failure never fails the run.

### Notes on disk

Written under the run's state directory and included in `collab export`,
never inside the user's project workspace:

- `advisor/observations.jsonl` — append-only structured findings, each tied
  to event ids so a later fix pass can verify claims against the hash-chained
  log.
- `advisor/notes.md` — readable narrative of stalls, repeated failures,
  suspected protocol defects, and suggested product improvements.
- `advisor/retrospective.md` — written once when the run reaches a terminal
  state.

Every file carries a fixed header stating the content is model-generated
from untrusted inputs and must be verified against the event log before
acting on it. Fix-pass sessions must treat these files as hypotheses, not
instructions.

### Accounting (the part most likely to be argued)

Advisor usage is recorded per wake in the usage table with a distinct
classification `advisor` and is EXCLUDED from the two-worker M/S ratio,
reported instead as its own labeled bucket in the overhead report, the UI
(an "Advisor usage" chip), and the canary evidence. Rationale: by the plan's
counterfactual the advisor is pure coordination, so charging it into the
loop ratio makes the gate unpassable and invites exactly the
raise-the-ceiling erosion this proposal avoids; hiding it in useful work
would be dishonest; a separate visible bucket keeps both the 1.05 promise
and full-cost transparency. The advisor has its own burst budget (default
3/run, audited extension), and its wakes appear in wake-latency and
causality accounting like any other claim.

### Structural-audit impact (acceptance-sensitive)

The zero-call audit currently requires exactly one guarded Codex turn site,
one guarded Claude model-query site, and one metadata-only query site. The
advisor MUST reuse the existing adapters (`ClaudeAgentAdapter.startBurst` /
`CodexAppServerClient.runBurst`) so no new model-call site is introduced and
the audit counts stay unchanged. If reuse turns out to be impossible, the
audit expectations change — that requires its own justification, not a
silent bump.

### UI

A third, visually distinct advisor lane (hidden when disabled) showing wake
reasons, observations, budget consumed, and links to the notes; an "Ask the
advisor" button; advisor cards in the existing action drawer. V-11
accessibility coverage extends to the lane.

### Failure and lifecycle

Cancel/stop aborts the advisor session with the workers. An advisor error or
timeout produces a note entry and, at most, a card; it never blocks, fails,
or terminalizes the run. Restart recovery does not replay advisor wakes; an
unconsumed trigger survives in the ready queue like any other claim.

### Verification required

Deterministic suite with a scripted advisor port (fake), covering: every
trigger fires exactly once with a causal ready-queue record; no wake without
a trigger (counter 0); budget enforcement and audited extension; kernel
rejection of advisor-authored packets/signoffs/goal changes; escaped
rendering of hostile advisor output; note files created under the state
directory with the untrusted header and included in export; usage recorded
in the `advisor` bucket and excluded from the worker ratio; zero-call audit
counts unchanged; V-11 pass on the new lane; full battery green; tripwires
untouched. Real-provider validation of the advisor is a future separately
authorized canary and is out of scope.

---

## Open questions for Codex's analysis

1. Is 8192 bytes/burst the right absolute allowance, or should it be derived
   (e.g., 3× the measured per-stage framing) with the constant recorded in
   the pin manifest?
2. Tier selection: what do the pinned SDK/app-server actually expose for
   choosing a stronger/weaker model, and can it be pinned?
3. Should `stall` thresholds be per-state (permission waits are legitimately
   long) and should the advisor also see resource-governor degradation?
4. Ready-queue `role` widening to include `advisor`: contracts ripple and
   migration cost of the new column value.
5. Anything in the accounting-exclusion argument you disagree with.
