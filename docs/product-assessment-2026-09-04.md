**Product assessment — September 4, 2026**

**Recommendation: keep the project, replace its default collaboration workflow, and validate the benefit before expanding it.** Build a tool for improving answers, decisions, and planning documents. Reuse the local service, history, provider boundaries, and useful interface components. Treat automated implementation as a separate future capability.

This is a recommendation from a review, not an implementation handoff claiming the proposed changes are complete. Application source was not changed. Existing uncommitted work was preserved. The new files are this assessment and review evidence under `artifacts/review-2026-09-04/`.

**What the existing work demonstrates**

The original [planning protocol](/Users/coldistric/source/repos/codex-claude-communication/TEMPLATE/protocol.md:7) is close to the outcome described in this request: independent investigation, evidence-backed objections, revised plans, and implementation as a later goal. The newer [product brief](/Users/coldistric/source/repos/codex-claude-communication/tasks/2026-07-25-collaboration-product-blueprint/product-brief.md) broadened that into a general execution product. Much of the complexity follows from that broader scope.

The historical work contains meaningful critique. For example, the [robot-plan transcript](/Users/coldistric/source/repos/codex-claude-communication/tasks/2026-07-15-autonomous-weed-robot-plan-review/transcript.md:290) records a reviewer withdrawing an unsupported recommendation after a challenge and revising the plan. It also records arithmetic and sequencing corrections. These are concrete examples of the interaction you want. I did not independently revalidate the historical robotics claims in this review, and the examples are not a controlled comparison showing two models always outperform one.

The app has real engineering substance: a durable SQLite event store, independent openings, persistent provider sessions, cancellation and recovery handling, permission boundaries, usage accounting, export, legacy browsing, and a compact Preact frontend. The build succeeds. Its deterministic tests cover valuable reliability properties. This work is worth retaining selectively.

However, the product now contains roughly 16,086 lines across the inspected TypeScript/TSX source and CSS, excluding tests and docs. The main runner is 2,575 lines, coordinator 1,182, UI component 1,635, and adviser service 1,123. These counts are maintenance context, not evidence that the code is bad. They explain why another general-purpose supervisor or architectural rewrite should have to justify its cost.

**What I actually verified**

I reviewed the root protocol, product brief and blueprint, implementation and review documents, main production runner, coordinator, contracts, adapters, persistence and completion logic, accounting, verification tools, UI, and representative historical tasks. I ran the build and full existing test suite, inspected the running app through its UI using an isolated database, ran provider metadata preflight, and added three deterministic counterexample probes. This was not an exhaustive security audit of every source line.

| Check | Current observation | Evidence |
|---|---|---|
| Build | TypeScript and Vite pass | [build log](/Users/coldistric/source/repos/codex-claude-communication/product/artifacts/review-2026-09-04/build.log) |
| Existing unit/integration tests | 212 tests in 34 Vitest files pass | [test log](/Users/coldistric/source/repos/codex-claude-communication/product/artifacts/review-2026-09-04/tests-unsandboxed.log) |
| Browser/accessibility harness | Pass; zero serious/critical axe findings in the exercised states; keyboard, reflow, history and restart checks pass | Same test log, V-11 result |
| Version pins | Fail: expects Codex `0.146.0-alpha.3.1`; installed binary reports `0.153.1` | [pin log](/Users/coldistric/source/repos/codex-claude-communication/product/artifacts/review-2026-09-04/pins.log) |
| Structural model-call audit | Fail: substring check matches `turn/started` notification in the runner | [audit log](/Users/coldistric/source/repos/codex-claude-communication/product/artifacts/review-2026-09-04/zero-call.log) |
| Metadata-only provider check | Neither route ready. Codex returns plan identifier `prolite`, absent from the app's allowlist. Claude reaches `billing_route_unproven` with plan `max` | [doctor log](/Users/coldistric/source/repos/codex-claude-communication/product/artifacts/review-2026-09-04/doctor-unsandboxed.log) |
| Fresh app interaction | Form and advanced controls work; a read-only planning request reaches preflight-blocked; cancellation works | [UI event evidence](/Users/coldistric/source/repos/codex-claude-communication/product/artifacts/review-2026-09-04/ui-events.json) |
| Targeted workflow probes | All three counterexamples reproduced using scripted provider ports | [probe results](/Users/coldistric/source/repos/codex-claude-communication/product/artifacts/review-2026-09-04/workflow-probes.json) |

The first test/doctor runs hit this session's filesystem and loopback sandbox limits. The authorized runs with local server access resolved those environment failures; their logs above are the relevant results. The UI's separate launch reported Claude subscription OAuth unavailable, whereas the doctor reached billing-route-unproven. Neither observation warrants asserting that you need a new account or that your subscription expired. The adapter currently loses useful error detail when metadata probes fail.

There were **zero model turns through the app**. The isolated UI database has zero provider usage rows and contains no worker starts. I did not bypass billing checks, change credentials, update dependencies, consume reset credits, run a fresh live V-13 canary, or repeat the historical 30-minute soak. Old successful canary reports do not establish current readiness.

**Findings that determine the product direction**

1. **The default workflow serves a broader, different job.** The [production prompts](/Users/coldistric/source/repos/codex-claude-communication/product/packages/service/src/real-runner.ts:246) perform two openings, appoint Codex implementation lead, ask Claude to review and repair using tools, then request sign-offs. A planning document can be produced as a workspace file, but planning is not the core contract. The manifest has artifact references and verification commands, with no primary answer/document body. General questions should not require selecting a repository just to obtain an answer.

2. **Material rejection has no working revision cycle.** In the [runner](/Users/coldistric/source/repos/codex-claude-communication/product/packages/service/src/real-runner.ts:843), an existing candidate skips drafting and review. In the probe, both providers made three initial bursts; Claude rejected the candidate and asked for a material correction. Clicking the real coordinator's Extend budget action caused one more Claude sign-off burst, with the same candidate digest. Codex did not draft again and Claude did not review a revision. The run returned to waiting for the user. This is a direct failure of the desired improvement loop.

3. **Agreement and adequacy are conflated.** A probe explicitly requested a substantive written plan, but an empty manifest with no artifacts, evidence, or verification reached `completed_consensus` when both scripted providers signed. A second probe reached the same state with a failed verification entry. The [completion guard](/Users/coldistric/source/repos/codex-claude-communication/product/packages/kernel/src/store.ts:610) checks matching signatures, not satisfaction of the requested deliverable. This does not mean live models inevitably generate empty results. It means the application has no structural protection against that failure. Nor is every failed check incompatible with a good answer: an audit that correctly reports failures can be successful. Track agreement, fulfillment of required conditions, and evidence status separately.

4. **Readiness checks have drifted away from production behavior.** The standalone pin verifier catches drift, but the [real runner supplies `versionMatches: true` and `schemaMatches: true`](/Users/coldistric/source/repos/codex-claude-communication/product/packages/service/src/real-runner.ts:487) rather than deriving them from a checked runtime. Separately, the Codex plan allowlist rejects the observed `prolite` identifier and suggests logging in again. Claude billing detection relies on a method literally named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. Blocking unknown billing is appropriate under the existing constraint; pretending the version check passed or giving an inaccurate recovery message is not.

5. **Clarification is incomplete.** The [Codex request handler](/Users/coldistric/source/repos/codex-claude-communication/product/packages/service/src/coordinator.ts:875) immediately answers `item/tool/requestUserInput` with an empty answers object. A document/decision assistant needs a real path for material missing information. This finding is from source inspection, not a new live provider request.

6. **The tests measure operation much better than benefit.** Existing tests exercise recovery, authority, causal work accounting, and digest agreement. The historical full-flow canary produces an exact small text artifact. Neither demonstrates that the resulting recommendation is more accurate, useful, or concise than a strong single-model response. The overhead ratio compares classified work within a run, not output quality against a single-model or self-review baseline. Keep raw usage and latency; stop treating a favorable coordination ratio as evidence of product value.

**The Claude challenge during this review**

I asked Claude through its normal signed-in web interface for an independent product judgment based on a factual summary, then challenged its proposed replacement. This was two live Claude chat turns outside the app. Claude did not inspect the repository or execute these tests; this was an advisory review of my summary, not an independent code audit.

Claude first favored shelving the app and testing a small script. Its useful objection was that elaborate coordination and passing tests can conceal an unvalidated outcome. I challenged three points: a CLI does not resolve billing uncertainty, blind first answers still need an independence barrier, and a script does not replace the user's goal-once UI and history. Claude revised its position to selective reuse, conditional on a small working document/revision experiment.

I retain a qualification: an executed shell command is not a universal validity requirement for a planning document, and structural validation cannot establish that every substantive claim is true. Evidence and acceptance rules must fit the task. Likewise, changes to the state machine alone do not justify a full rewrite; isolate the new workflow and measure the coupling first.

The [Claude conversation](https://claude.ai/chat/7adc5f4f-13ec-4335-ab9b-40650663150a) is saved in your account. No public share link was created. This exchange is a small example of review changing a recommendation, not a benchmark proving the approach superior.

**The proposed product**

Keep one natural-language entry point: “What would you like help deciding, answering, or planning?” Make a project folder optional. Let the app create its own output location for ordinary questions. Use uploaded/selected context and explicitly chosen read-only sources when needed.

Use this bounded sequence:

1. Clarify only material unknowns; otherwise record assumptions.
2. Both providers write concise independent proposals from the same brief and evidence packet, without peer answers.
3. Each reviews the other's proposal. Record concrete objections, supporting evidence, severity, and suggested corrections. “No material objection” is a valid response.
4. One provider synthesizes a document, preserving the stronger evidence and meaningful disagreements. Alternate synthesis roles during evaluation to detect author bias.
5. Review that exact revision. A material objection routes to a new revision, invalidates prior approvals, and records what changed. Start with one review/revision cycle and allow at most one additional cycle for a specific unresolved issue; then stop with the disagreement visible.
6. Present the answer, evidence, assumptions, changes caused by critique, remaining disagreements, and practical next steps. Offer Markdown export. Retain detailed messages as expandable history.

Use read-only project access for planning and let the service persist returned document content in its own output directory. Evidence gathering can include scoped read tools and explicitly needed research; starting with supplied-context tasks makes the first evaluation cheaper. Implementation requires a separate user request and execution workflow.

A useful stored review object would contain a document revision/body, claims and evidence references, objections with dispositions, explicit assumptions, and reviewer verdicts (`approved`, `revision_requested`, `disagreement`, or `needs_input`). Keep revision digests for identity, not as a substitute for content evaluation. An objection should say whether a decision, correctness, feasibility, or material risk changes; do not create issues merely to satisfy a debate quota.

The primary screen should show the current document and the few decisions that need attention. Provider lanes, resource details, work packets, digest strings, and accounting can remain in a details view. The current shell is usable and has passed the exercised accessibility checks; a cosmetic redesign is not the first priority. Correct the advanced-settings text, which currently says mutations ask by default while its selected option recommends automatic workspace commands.

**Keep, replace, and defer**

| Area | Recommendation |
|---|---|
| Local service, SQLite persistence, history, export, session security | Reuse; introduce versioned document records without rewriting historical tasks |
| Provider adapters and billing boundaries | Reuse the boundaries; repair runtime compatibility and preserve diagnostic causes |
| Independent opening barrier, cancellation, bounded budgets | Keep and adapt to document stages |
| Fixed implementation-lead runner | Replace with a document deliberation runner |
| Manifest and sign-off contract | Extend or version for document content, per-objection dispositions and distinct fulfillment/consensus states |
| Current web UI | Reuse shell and components; make the document the main view |
| Concurrent mutation leases, desktop/browser coordination, implementation recovery | Leave outside the planning path; do not delete proven machinery simply to reduce line count |
| Optional model adviser | Leave disabled; no evidence yet that another model improves this user journey |
| Elaborate overhead gates and new platform features | Defer further work; expose simple total usage, duration and useful review changes |
| Legacy file protocol | Keep as a manual fallback/reference; do not restore model polling as the primary transport |

**Integration choice**

The chosen integration families are reasonable. Official OpenAI documentation describes [app-server](https://learn.chatgpt.com/docs/app-server) as the interface for custom clients needing authentication, history, approvals, and streamed events, and the [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) as an automation option. There is no reason to add a new agent framework merely to alternate two providers. Keep orchestration deterministic.

Anthropic's current [Agent SDK plan notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says the announced billing change is paused and SDK/noninteractive usage still draws from subscription limits. That supports investigating the existing personal subscription route; it does not prove this installed adapter's effective billing route. Its [credential guidance](https://code.claude.com/docs/en/legal-and-compliance) also distinguishes end users signing in through the unmodified official binary from intermediating other users' credentials. This recommendation concerns personal local use. Distribution to other users requires a separate integration and policy review.

Use the existing official interfaces and verify compatibility. Pin a runtime the project actually controls or explicitly support tested installed versions; a version string pointing into an auto-updating desktop application is not an immutable dependency. Never fix drift by merely changing the expected version until a check turns green. Browser automation was useful for this one-off Claude critique, but it would add fragile UI dependencies as the app's normal transport. Direct paid APIs remain a possible future product choice only if you explicitly change the subscription constraint.

**The next work, in order**

1. Restore an honest compatibility check: derive runtime/schema evidence, distinguish unknown plan identifiers from missing login, and preserve Claude auth/usage errors with secret redaction. Repair the substring audit to inspect actual invocation sites. No bypass of unknown billing and no API fallback.
2. Implement one narrow document path: stored body, task-appropriate required conditions, explicit objections, reject-to-revise, and real clarification cards. Keep it isolated from implementation orchestration. Add regressions for the reproduced counterexamples, including preserving disagreement and invalidating approvals after a revision.
3. Test on real planning/answering tasks before expanding the UI. Use the evaluation below. This is the investment decision point.
4. If the evaluation is useful, make that workflow the default and simplify the main screen. Rebuild only the parts whose coupling makes the narrow workflow harder to maintain than a replacement. Do not rewrite the whole app on the strength of code size or frustration alone.

No user action is required to understand or use this assessment. A fresh automated dual-provider trial remains blocked on compatibility/billing evidence. If the repaired metadata check demonstrates a real login expiry, the user must complete the provider's own sign-in flow; the exact need should be established before requesting it. App repairs and new quality trials have not been performed in this assessment.

**A practical quality evaluation**

Start with six smoke scenarios: a time-constrained learning plan; an ambiguous project request requiring one clarification; a proposal containing a seeded factual/arithmetic mistake; a decision with two legitimate preference-dependent outcomes; an underspecified research question with unavailable evidence; and a simple question for which extra debate should add little. The pass criteria include honoring scope, correcting the seeded mistake, preserving real uncertainty, avoiding unnecessary implementation, and producing a readable answer.

Then use approximately 20 actual questions from the user's backlog. Compare: (A) a strong single-model answer, (B) that model with one self-review pass, and (C) two-provider review. Balance which provider is the single-model baseline and which synthesizes C. Use the same brief, available evidence/tools, output-length limit, and clearly recorded work budgets. Report both user preference and total consumption/latency; do not conceal extra work behind an overhead-only ratio. Include some repeated runs to expose variability.

Randomize and hide the condition labels during review. The user rates practical usefulness, accuracy, actionability, constraint adherence and unnecessary complexity. Use objective checks for seeded errors and verifiable claims. An additional model judge may help triage, but should not be the sole authority. A review should show what changed because of the second provider; added length alone earns no credit.

As a proposed personal decision rule, continue if two-provider output is preferred to self-review in at least 14 of 20 comparisons, introduces no additional serious known errors, and its observed time/usage feels worth the improvement. This is a heuristic for a small personal trial, not a statistically established guarantee. If the benefit concentrates in complex plans, use two providers there and offer a lighter path for routine questions. If it does not beat self-review, keep a simple answer-plus-optional-second-opinion tool rather than expanding the debate system.

The decisive product promise should be a better supported, usable result with visible uncertainty. Agreement is useful when the evidence warrants it; agreement itself is not the deliverable.
