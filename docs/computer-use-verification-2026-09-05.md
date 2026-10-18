# Computer-use verification — September 5, 2026

The tested planning flows passed after fixing a session collision and adding per-run model selection. Two real collaborations completed with both providers approving the same revision and every required condition marked met. These are smoke tests of the installed app and providers, not a statistical estimate of failure probability or a guarantee for arbitrary future tasks.

Testing used the normal production build and service entry point on `http://127.0.0.1:3003`, with isolated state at `product/artifacts/computer-use-2026-09-05/state`. The ordinary application database was not used. Computer interactions were performed through the computer-use browser tool. Deterministic fixtures were served separately on port 3002 and were never counted as live model evidence.

Changes completed:

- Added Codex model/reasoning and Claude model/effort selectors under **Context and limits**. Selections are validated against provider catalogs, saved in the immutable goal, and preserved on restart. Explicit selections fail if unavailable; they do not silently fall back. Completed calls record the resolved model in diagnostics.
- Fixed a reproduced cookie collision: two localhost instances previously shared `collab_session`, so starting one invalidated browser access to the other. Cookies now have a stable name specific to the state database. Existing valid sessions migrate on restore. HttpOnly, SameSite, origin, and CSRF checks remain enforced.
- Fixed an intermittent accessibility-test race where axe sampled old foreground colors immediately after changing the emulated system theme. The check now waits for the rendered foreground to change before measuring contrast. No application palette change was needed.

| Check | Evidence type | Result |
| --- | --- | --- |
| Empty goal | Computer use, fixture app | Browser validation prevented a run |
| Invalid project path | Computer use, fixture app | Clear error; entered goal preserved |
| Correcting invalid path | Computer use, fixture app | Removing the path started the requested workflow |
| Clarification | Computer use, fixture app | Paused with an input card; answering resumed the run |
| Revision and approval | Computer use, fixture app | Material objection produced a second revision and fresh approvals |
| Earlier revision | Computer use, fixture app | Earlier rejection remained visible; latest approval was not applied to it |
| Export | Computer use plus file inspection | Fixture and both live documents were written and matched saved content |
| Model picker | Computer use plus provider calls | Luna/high and Opus selected and confirmed in completed-call records |
| Brief-only collaboration | Real providers | Reviewed document; all required conditions met |
| Reload while working | Real providers, computer use | Progress and single history entry preserved |
| Selected-file collaboration | Real providers | Correct comparison and recommendation from synthetic source files |
| Draft during background work | Computer use | Draft text and model selections survived incoming progress updates |
| Dark theme | Computer use plus axe | Readable rendered UI; zero serious or critical contrast violations in final suite |
| Phone-width layout | Computer use, 390 × 844 | Zero horizontal document overflow; model controls usable |
| Service restart | Computer use plus event-store verification | Both live results, selections, revisions, and valid hash chains preserved; no extra calls |
| Cancellation | Computer use, fixture app | Cancelled state persisted on reload; no document falsely labeled complete |
| Two local instances | Reproduced bug, regression, computer use | Both sessions now survive alternating reloads |

| Live run | Models | Calls | Reported tokens | Outcome |
| --- | --- | ---: | ---: | --- |
| `run_f1009d67-d206-45bd-948f-f49a7005d772` — 30-minute retrospective checklist | `gpt-5.6-luna` / high; `claude-opus-5[1m]` / medium | 7 | 48,455 | Both approved; three timed sections total 30 minutes; one follow-up action |
| `run_f8e6fb2f-6e7e-47cd-bdb0-1a7ad7358aa7` — synthetic workshop comparison | Same | 7 | 51,315 | Both approved; correctly recommended $80 / 45-minute Option A over $100 / 60-minute Option B |

Both runs used subscription allowance at their recorded billing checks. Claude effort stayed at the app's medium default; the requested high reasoning applied to Codex. Token totals include reported input, cached input, and output; they are not dollar costs. The two source files' SHA-256 values were unchanged after the live run. Model agreement was not used as a substitute for checking the simple arithmetic and required output structure.

Final automated verification: build passed; **249 tests across 39 test files passed**, plus the browser accessibility suite. Its final results include zero serious/critical violations in light and dark modes, zero horizontal reflow overflow, keyboard completion, no duplicate SSE history entries, and restored run/action-card history. The zero-call structural audit passed with no forbidden billing calls. The session regression also covers cross-instance token rejection, legacy-cookie migration, and restoring the same database on a different port.

Evidence is saved in `product/artifacts/computer-use-2026-09-05/`: `automated-tests.log`, `provider-health.log`, `zero-call-audit.log`, `live-results-before-restart.json`, `restart-verification.json`, the synthetic source files, the fixture export, and both real exports under `state/exports/`.

The app is left running on port 3003 with the successful live results visible. The fixture preview is stopped. No further model work is running. Models other than the selected Luna and Opus were not live-tested; provider outages, future runtime updates, long-running load, and the historical execution workflow are outside this smoke-test evidence. No user action is required to finish this verification.
