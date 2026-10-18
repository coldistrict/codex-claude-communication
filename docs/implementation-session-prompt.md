Please correct and update this application, and implement the product direction described below. This is an implementation request: inspect, make the necessary changes, run the app, test it, and deliver a working result. Do not stop after producing another assessment or plan.

Workspace: `/Users/coldistric/source/repos/codex-claude-communication`

Application and Git repository: `/Users/coldistric/source/repos/codex-claude-communication/product`

Read these existing, verified files first:

- Assessment: `/Users/coldistric/source/repos/codex-claude-communication/product/docs/product-assessment-2026-09-04.md`
- Review evidence and logs: `/Users/coldistric/source/repos/codex-claude-communication/product/artifacts/review-2026-09-04/`
- Reproducible workflow counterexamples: `/Users/coldistric/source/repos/codex-claude-communication/product/artifacts/review-2026-09-04/workflow-probes.ts`
- Current application README, package scripts, local instructions, and relevant source/tests.

The assessment is evidence and a starting point, not an infallible specification. Recheck the current state and improve the proposed implementation when the code or evidence warrants it. In particular, “document review” is too narrow a description of what I want.

**Product purpose**

I want one local place where I describe a rough idea, question, decision, planning goal, or existing proposal. Codex and Claude should each contribute, challenge weak assumptions, investigate relevant evidence, revise their positions, and produce a useful answer or plan. I do not need an existing document to begin. Creating a plan from scratch is a primary use case.

The result should clearly explain the recommendation or answer, practical next steps, important assumptions, supporting evidence, changes caused by the review, and remaining disagreements or questions. Agreement is useful when justified; do not force agreement or invent objections merely to create a debate.

Implementation of whatever the resulting plan proposes is a separate later user request. This session DOES authorize modifying the collaboration application itself to deliver the workflow described here.

Keep one natural-language entry point rather than requiring me to classify every request. A repository or project folder should be optional for ordinary questions and plans. The application should manage its own document output location. Selected project sources should be read-only during planning, while the service can persist returned documents in its managed output directory.

**Reuse and working boundaries**

Preserve the useful local service, provider adapter boundaries, SQLite history, export, session security, independent-opening barrier, cancellation, and compatible UI components. Replace or isolate the implementation-focused runner with a document/planning workflow. Prefer a focused refactor over a full rewrite, unless a concrete implementation spike demonstrates that selected components are cheaper and safer to replace.

There is substantial pre-existing uncommitted work in the product repository. Inspect and preserve it; do not reset, overwrite, or clean it away. Keep historical task folders and prior evidence intact. Put fresh test outputs in a new evidence directory. Back up persistent state before any migration and verify compatibility with saved runs. Use isolated test databases and workspaces for destructive or failure-injection tests.

Do not add another framework, model supervisor, desktop-automation subsystem, or elaborate accounting layer merely to implement this loop. Keep the optional adviser disabled by default and execution-specific machinery outside the new default planning path. Preserve useful existing safeguards without turning every routine step into an approval request.

**Required work**

1. Restore reliable, honest provider compatibility. Check current official documentation and the exact installed Codex and Claude runtimes. Update dependencies and adapters where needed for compatibility and supported operation; avoid unrelated upgrades. Derive version/schema checks from real observations instead of supplying hardcoded successful predicates. The assessment observed a stale Codex pin, an unrecognized returned plan identifier, and Claude authentication/billing metadata failures. Do not assume those exact conditions remain unchanged. Distinguish missing login, unknown plan, changed metadata, and genuine usage limits; preserve useful, redacted diagnostic causes and show actionable recovery messages. Do not merely change a pin or relax a check until it turns green. Repair the structural model-call audit so a notification name is not mistaken for an invocation, while retaining meaningful guard coverage.

2. Implement the actual collaboration loop. Give both providers the same brief and relevant context, collect independent proposals before exposing peer answers, obtain concrete cross-reviews, synthesize a document, and review its exact revision. A material rejection must lead to an actual revised candidate and renewed review. Invalidate approvals when the document changes. Extending the budget must enable useful new work rather than repeatedly requesting approval of the unchanged candidate. Start with one review/revision cycle and a bounded additional cycle for a specific unresolved issue; then show the unresolved disagreement rather than looping indefinitely. Keep the synthesis role configurable internally so evaluation can check author bias; do not require another user-facing selector.

3. Make documents and review outcomes first-class. Store a readable document body, revision identity, claims/evidence references where appropriate, assumptions, objections, dispositions, and reviewer verdicts. Separate provider agreement from task fulfillment and evidence status. A request for a substantive plan must not complete successfully with an empty result. Unfulfilled required conditions must remain visible and prevent a misleading “ready” state. Do not require every incidental command to pass: an audit can correctly conclude that checks failed, and a useful conceptual plan may need no shell command. Structural validity is not proof that all claims are true. Preserve meaningful dissent and distinguish unsupported claims from verified facts.

4. Complete the interaction path. Route material clarification requests to real user-input cards and resume correctly with the answer. Do not silently answer requests for user input with an empty object. Put the current answer/plan and decisions needing attention at the center of the UI, with messages, provider activity, evidence, usage, and technical diagnostics available in details. Support Markdown export and revisiting saved documents. Make permission defaults and explanatory text agree. Keep the interface useful when a provider is unavailable, with an honest blocked or partial state; never invent a second provider's approval.

5. Verify through the real application path. Turn the existing counterexamples into meaningful regressions for empty results, required-condition failures, reject-to-revise, changed-revision approval invalidation, preserved disagreements, and clarification/resume. Also verify optional project context, read-only source protection, persistence/export, cancellation, and the existing security/recovery behavior affected by the changes. Run the relevant build, unit/integration, provider compatibility, model-call audit, and browser/accessibility checks. Exercise the actual UI rather than relying solely on scripted provider tests. Keep fresh evidence and distinguish deterministic fixtures from live results.

6. Add a small quality-evaluation path. Compare a strong single-model answer, a single model with self-review, and the two-provider workflow under the same brief, evidence, output-length constraints, and recorded work budgets. Include plan creation from a rough goal, an existing proposal with a seeded mistake, an ambiguous request, and legitimate unresolved tradeoffs. Capture useful corrections, unsupported claims, practical usefulness, length, latency, and actual usage. Support hiding condition labels for human review. A small live trial can establish feasibility; do not claim statistically proven superiority, invent my preference ratings, or run a large benchmark without an agreed budget. If the comparison does not establish a quality improvement, report that honestly without concealing it behind consensus or overhead metrics.

**Subscription and live-testing boundaries**

Preserve the existing documented billing constraint: subscription allowance first, and existing provider-managed prepaid credits only to the extent already explicitly authorized in the project's recorded policy. Do not create or select paid API credentials, purchase credits, enable top-ups, consume reset credits, or change account billing. Use the official provider authentication flows; never extract or copy credentials into the project.

After verifying the effective approved billing route, this request authorizes a small, bounded live smoke test of the corrected planning workflow using existing subscription allowance. Use synthetic or non-sensitive supplied context, read-only source access, explicit call/turn/time limits, and at most three end-to-end scenarios with a single revision cycle each. Stop live testing on usage limits, uncertain billing, or repeated failures. Do not bypass a failed billing check by switching to another CLI or browser route. Treat any larger comparative evaluation or additional credit consumption as a separate budget decision.

If authentication requires me to interact, or a genuine product decision or permission is missing, explain the exact blocker and ask one focused question. Continue independent authorized work while awaiting it. Do not ask me to perform setup that you can safely complete and verify yourself. Do not claim the app is fully working if real-provider verification is still blocked.

**Completion and delivery**

Work in small, reviewable stages, keep concise progress updates, and continue until the authorized implementation and verification are complete or a specific external prerequisite genuinely blocks the remaining work. Keep infrastructure changes proportional to the planning/answering use case.

Deliver the updated application, regression coverage, fresh verification evidence, concise setup/usage documentation, and a short report stating what changed, what actually passed, any unresolved blocker, and what the live/quality evaluation does and does not demonstrate. Launch instructions must refer to prerequisites and files you have actually checked. Keep the review assessment and historical records as history, and document the new behavior in current app documentation.
