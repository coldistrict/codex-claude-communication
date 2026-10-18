# Live testing — September 5, 2026 (Claude session)

Real end-to-end tests of the planning app after Codex's model-picker, session-cookie, and UI-review work. Every collaboration used the cheaper catalog rows the user asked for: Codex **Sol** (`gpt-5.6-sol`, medium) and Claude **Opus (1M context)** (`opus[1m]`, resolved to `claude-opus-5[1m]`, medium). The service ran the production build from `npm start` on `http://127.0.0.1:3005` with isolated state in the session scratchpad; the ordinary application database was not touched. The browser was the Claude Code in-app Browser pane at 1280 × 900 and 390 × 844.

## What was tested

| Test | Evidence | Result |
| --- | --- | --- |
| Launch from a Claude Code shell | Real preflight | Blocked as designed: the shell exports `ANTHROPIC_BASE_URL`, which the environment scrub treats as a custom route. Relaunching with a clean environment and one click on **Retry preflight** cleared both cards. |
| Brief-only decision (monorepo vs separate repos, one required condition) | Real providers | `completed_consensus`, 7 calls, both approved, condition met, about 4 minutes. Sol and Opus confirmed in diagnostics. |
| Project folder with four selected files plus a binary | Real providers | First attempt **failed**: Claude's proposal was rejected with raw `DOCUMENT_CONDITION_INVALID` and the run died with only a Cancel button after 31k tokens. Root cause and fix below. |
| Same project run after the fix | Real providers | `completed_consensus` after one genuine revision cycle: Codex requested a revision with two material objections, Claude approved with minor notes, revision 2 was approved by both. 10 calls, about 125k tokens, zero repair retries. |
| Underspecified goal (“option A or option B”) | Real providers | Codex asked one focused clarification; answering it resumed the proposal stage with the answer. |
| Cancel while a provider call is running | Real providers, reload | Header Cancel ended the run; after a reload the run shows Cancelled, “No document produced”, “Not reviewed”, no spinner. No orphan provider processes. |
| Service killed mid-call, restarted | Real providers, reload | “Resume saved planning work” card appeared with Codex's proposal preserved; **Retry collaboration** resumed at Claude's proposal without redoing Codex's. The resumed run (replace a 60-minute all-hands) went through two revisions, then paused on the “specific unresolved issue” card. **Keep partial result** ended it honestly as `completed_disagreement`: “Partial result”, “Disagreement recorded”, both revisions browsable, remaining disagreements listed. 11 calls. |
| Composer draft across close and reopen | DOM | Draft text and model selections survived. |
| Invalid project path | DOM | Readable focused error inside the dialog, draft preserved, no run created. Double-clicking Start created one run. |
| Revision history | DOM | Revision 1 shows its own “Revision requested” status and the “Earlier revision” notice; “Back to latest” returns to the approved revision. |
| Export run / Export Markdown | File inspection | `document.md`, `events.jsonl`, `projection.json`, `transcript.md` written under the state exports folder. |
| Light, dark, and system themes | Screenshots | Persisted in `collab.theme`; both palettes readable. |
| Phone width 390 px | DOM and screenshots | Zero horizontal overflow before and after the heading change. |
| Regression suites | `npm test`, `verify:ui-regressions`, `verify:planning-ui` | 254 unit tests pass (25 in the planning file, 5 new); both browser suites pass with 0 serious or critical axe violations and 0 px overflow. |

## Defect found and fixed

`validateDocument` and `validateReview` require every returned condition string to equal a required condition exactly. The prompt never said so. Opus returned `"…numbered requirements"` without the trailing period and volunteered five extra `Req N` conditions, which was a good answer structurally rejected. The runner turned that single rejection into a dead run with a raw code and no retry.

Changes in `packages/service/src/planning-runner.ts`:

- The prompt now states the rule: exactly one entry per required condition, copied verbatim, no additional conditions.
- `normalizeConditions` maps returned conditions onto the required strings with a tolerant comparison (case, whitespace, quotes, trailing punctuation), drops duplicates, and keeps volunteered conditions visible as unresolved notes on documents. Nothing is invented and no status changes.
- A structurally rejected answer (`PLANNING_OUTPUT_NOT_JSON`, `PLANNING_EMPTY_RESULT`, `DOCUMENT_*`, `REVIEW_*`) is re-requested once with the exact rejection reason. The repair notice precedes the evidence packet so the JSON stays the final prompt segment. Each attempt is a charged call and is recorded as an `output_rejected` step; the `review` stage is now validated inside the call so it gets the same treatment.
- When the repair attempt also fails, the card is written in plain language, names the provider, keeps the raw code at the end, and offers **Retry collaboration**, which resumes at the failed stage because completed steps are cached by key. Only an unavailable explicit model or effort selection keeps Cancel alone.

UI changes:

- Briefs longer than 240 characters clamp to four lines with a “Show the full brief” toggle (`aria-expanded`, full text kept in the heading for assistive technology and the existing `#run-goal-heading` assertions). On a phone the brief previously filled the whole first screen.
- The execution-only “Worker-loop overhead” chip is hidden on planning runs.
- The diagnostics panel says when one call is in progress instead of “Incomplete”, and lists any repaired responses with their codes.

## Regressions added

`packages/service/test/planning.test.ts`, “fourth live trial regression”: tolerant condition mapping; the recorded live proposal shape completing the full coordinator path with no repair call; a non-JSON answer being re-requested once with the reason in the prompt and the packet still last; a twice-invalid review producing a retryable, provider-attributed card whose Retry resumes and completes; and the model-unavailable case offering no retry.

## Evidence

Exports of the three finished runs (`document.md`, `events.jsonl`, `projection.json`, `transcript.md`) and the automated suite logs are saved under `product/artifacts/live-testing-2026-09-05/`. Reported usage per run, counting input, cached input, and output tokens: the monorepo decision 7 calls and 65,269 tokens; the reconciliation plan 10 calls and 124,888 tokens; the all-hands replacement 11 calls and 101,100 tokens. The failed first reconciliation attempt consumed 2 calls and 31,445 tokens before it was cancelled; the clarification run consumed 3 calls and 18,211 tokens before the deliberate cancel. No run needed the repair retry after the prompt rule was added.

## Limitations

These are smoke tests, not statistics. Escape-to-close was not verifiable in the hidden in-app pane (keydown reached the dialog but the native close did not fire there); Codex's Playwright suite covers it in real Chromium and still passes. Codex never needed the repair path in this session; only Claude did, once, before the prompt rule existed. The adviser and the historical execution workflow were not exercised.
