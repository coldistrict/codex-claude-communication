# Planning implementation — September 4, 2026

The default real application path now produces answers and plans from a rough natural-language goal. A project folder is optional. The implementation runner remains isolated as the explicit `execution` workflow for historical clients and tests. The service, SQLite history, session security, export, cancellation, provider adapters, and existing UI shell were retained.

## Implemented behavior

- The same bounded source snapshot goes to both independent proposals before peer answers are exposed. Both providers cross-review; an internally configurable author synthesizes; both review the exact document revision.
- Material rejection causes an actual changed body and fresh reviews. Previous approvals cannot establish approval of a different revision or a changed clarification context. One automatic revision and one optional, issue-specific final revision bound the loop.
- Versioned documents contain Markdown body, assumptions, next steps, claims and source references, required conditions, objections, dispositions, changes, and remaining disagreements. Agreement, fulfillment, and evidence status are separate. Missing or empty results cannot be ready. Failed incidental checks can be an appropriate audit conclusion.
- Clarification cards support real user answers, including native Codex requests. Answers persist and feed resumed work; unfinished stages recover after restart. No empty answers are silently sent. A context-changing answer renews independent proposals and review eligibility.
- The UI centers the document, revision selection, decisions needing attention, and export. Evidence, messages, usage, and diagnostics are expandable. Source folders are optional and read-only; returned documents are written by the service to its managed directory.
- Planning uses no provider tools. The evidence packet includes the brief, project inventory/README, and explicitly selected bounded text files. General web investigation and binary attachments are not implemented; unsupported external claims must remain labeled. The adviser is disabled and not available in this path.
- Model calls use catalog-resolved defaults and validated medium effort. The planning profile has absolute call and run timeouts, a call budget, no automatic Claude continuation, and no execution leases or implementation tools.

## Compatibility and billing

Codex `0.153.1` was observed at the configured official desktop path. Its generated schema recognizes `prolite`, supports the fields this adapter uses, and is checked against the stored canonical schema hash. The project-local Claude SDK remains `0.3.220` with bundled CLI `2.1.220`; no unrelated dependency upgrade was necessary. Runtime checks happen in the adapters and override caller placeholders with observed version/schema/hash evidence.

The initial official Claude auth-status probe returned `loggedIn=false`. After the user completed official login, metadata proved subscription allowance for both providers. Unknown plan identifiers, missing login, failed probes, changed metadata, and genuine limits now have distinct outcomes. Redacted causes are retained. Claude's observed monthly spending cap does not prove prepaid funds: metadata can simultaneously report a cap and `out_of_credits`. The parser therefore does not treat that cap as an available balance.

The model-call audit now parses invocation sites and exact string tokens, so `turn/started` notifications are not counted as `turn/start` invocations. Its guarded call counts and alias/computed-call restrictions remain enforced. Every Claude continuation in the retained execution path now passes the model guard separately.

Sources checked: [official Codex app-server documentation](https://developers.openai.com/codex/app-server), the installed binary's generated JSON schema, the installed SDK's TypeScript contract, and [Anthropic's current SDK subscription notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). The latter's June 15 update says the announced change is paused and subscription limits still apply. This policy statement is combined with effective runtime metadata; it is not used as a substitute for a billing check.

## Preservation and verification

The pre-existing uncommitted changes were captured as a patch and source archive before edits. The persistent SQLite database was backed up using SQLite's backup API and passed integrity checking. No SQL migration was needed: document records are additive, versioned events within schema v2. Four saved runs replayed on an isolated copy with identical event counts, states, and valid hash chains. Historical task folders and the earlier assessment/evidence were not changed.

Fresh local evidence is in `artifacts/planning-2026-09-04/`. It includes source/state backups, observed runtime schema, metadata-only doctor results, regression/build/audit logs, browser screenshots, and separately labeled live trials. Tests and browser failures were investigated and corrected rather than hidden; intermediate logs remain in that directory. These local archives are excluded from Git. The repository includes a [verification summary](../artifacts/planning-verification-2026-09-04/summary.json), synthetic live results, a reviewed example, and the comparison protocol. The recorded response needed by regression tests is stored independently in `packages/service/test/fixtures/planning-uncited-claim.json`, so tests work in a fresh checkout.

| Check | Final result |
| --- | --- |
| TypeScript and Vite build | Passed |
| Unit/integration suites | 244 tests across 37 files passed, including 20 planning regressions |
| Installed runtime/pin checks | Passed with zero model starts |
| Structural model-call audit | Passed: one guarded Codex start, one guarded Claude query, one metadata-only query, zero forbidden billing calls |
| Existing security/recovery tests and browser suite | Passed |
| Planning browser checks | Passed: optional project, keyboard entry, clarification/resume, revision switching, Markdown export, restart/history, mobile reflow, light/dark accessibility; zero serious/critical accessibility violations and zero fixture model starts |
| Saved history compatibility | All four saved runs retained their event counts, states, and valid hash chains |
| Dependency state and whitespace checks | Passed |

The rebuilt app was launched with `npm start` against the backed-up default state. Its authenticated browser page displayed all four saved runs and the new planning form at the loopback address printed by the service. Merely launching and inspecting it started no new model calls. The verified restart/setup commands are in the current README.

## Bounded live results

All three authorized smoke trials used synthetic spreadsheet-learning context, subscription allowance, no provider tools, at most ten calls per trial, an eight-minute run limit, and at most one revision. No API credentials, purchases, top-ups, reset credits, or account billing changes were used. Fourteen model calls started in total; no further live testing was performed.

| Trial | Calls | Observed outcome |
| --- | ---: | --- |
| 1 | 6 | Saved a 458-word plan, then reached the eight-minute limit during review. Work remained partial, with incomplete usage reporting for the interrupted call. |
| 2 | 7 | Completed proposals, cross-reviews, synthesis, and both exact-revision reviews. Both providers approved the 451-word plan and confirmed both required conditions. Returned model calls took 208 seconds in aggregate. |
| 3 | 1 | Stopped after the first proposal because an uncited schedule claim was labeled supported. The response was retained as a regression fixture. |

Trial 2 corrected the supplied arithmetic mistake (two hours per week for four weeks is eight hours), removed unsupported competence assurances, narrowed the curriculum, and made assessment and setup contingencies concrete. Its recorded usage was 54,634 input, 776 cached-input, and 8,284 output tokens; the 102 reasoning tokens are a reported subset, not extra output. See [the live summary](../artifacts/planning-verification-2026-09-04/live-summary.json) and [the reviewed example](../artifacts/planning-verification-2026-09-04/reviewed-example.md).

Live testing exposed three implementation issues that were corrected: default reasoning effort made the first trial too slow; ordinary disclosed unknowns incorrectly kept the second trial's approved, fulfilled document in a partial state; and the third trial rejected an otherwise usable proposal instead of conservatively marking uncited claims unsupported. Cross-review objection identifiers were also namespaced to avoid collisions. Original live records retain their actual states, including trial 2's `completed_disagreement` state despite its separate `agreed` and `met` fields.

The final corrections pass deterministic regressions, including replay of trial 3's exact response through the corrected full workflow. They were **not rerun live** because all three authorized trials were used. Live feasibility is demonstrated by trial 2; a clean live completion on the final code remains unverified. Authentication is no longer blocked. Further live verification requires a new budget decision.

## Quality evaluation and remaining limits

`npm run evaluate:planning` prepares four cases: a rough planning goal, a proposal with a seeded mistake, an ambiguous request, and legitimate unresolved tradeoffs. The implemented comparison path uses the same brief, evidence, and requested output limit for a single answer, self-review, and the two-provider workflow. It records work budgets, actual usage, latency, answer length, corrections, and unsupported claims, and produces blinded outputs with a separate condition key and blank human-rating fields. Internal author selection supports checking synthesis bias.

The protocol and deterministic evaluator tests passed. A live three-condition comparison was not run under the smoke-test allowance. These results establish neither a quality advantage over a strong single model nor a user preference; no ratings were invented. Current evidence investigation is limited to supplied text and the bounded project snapshot. Automatic web research and binary source ingestion remain unimplemented and are disclosed in the UI/README.
