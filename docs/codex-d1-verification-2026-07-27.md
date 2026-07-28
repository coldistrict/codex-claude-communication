# Codex independent D-1 verification — 2026-07-27

## Verdict

**PASS — Defect D-1 is fixed, including against real providers.**

The dashboard's reactive adviser-wake counter matched the authoritative
`advisor_ledger` predicate at every observed state in a bounded real-provider
run. Two reactive observations plus one terminal retrospective rendered as:

`Wakes used: 2 of 2 reactive + 1 reserved retrospective`

The retrospective did not increment the reactive count, and the UI never
rendered the former `3 of 2` defect. No defect was found in the three-file fix.

This pass does **not** promote real-provider retry after failure or a literal
Codex `null` `recommendationCode` to passing; neither condition occurred.

## Evidence and source state

- Product root:
  `/Users/coldistric/source/repos/codex-claude-communication/product`
- Preserved live state:
  `/private/tmp/collab-d1-verify-20260727T1644Z`
- Live database:
  `/private/tmp/collab-d1-verify-20260727T1644Z/collab.sqlite`
- Run:
  `run_4e7a662b-06e3-456b-ad58-450adc1c7fb7`
- Database SHA-256 after clean shutdown:
  `e561f1a982da3ada20e6a61e0dc00584ef8dea95ffa8217e2fed7531d9ae27f5`
- `PRAGMA integrity_check`: `ok`

The workspace has no `.git` metadata, so a native `git diff` was unavailable.
I instead compared the current tree with the independent pass's preserved
108-file hash manifest:

`/private/tmp/collab-independent-test-2026-07-27/final-hashes.txt`

Only the two reported historical files differ from that manifest:

| File | Pre-fix SHA-256 | Current SHA-256 |
|---|---|---|
| `packages/ui/src/app.tsx` | `4e921908b701485d8c8c590ba6ffcde25a5d710a674ba669e9ea307962074eee` | `b1fa262740e9162a57b8ff661ab37e1552b1690f117f47c2001f329e00b17798` |
| `packages/ui/test/a11y.ts` | `c6c1529c0e5dd893110dfddaf3c2d4be1be4e27be7eeab838853965201256863` | `f73f0af8eb19986ae3baddd9690d2dbe1b1f1af9c87f339f9e6f55db9ef79588` |

The third changed file is the reported addition,
`packages/service/test/real-runner-retry.test.ts`, SHA-256
`34387bd94cc30811c1901ac7859706e2c80029b5a1e1e32277feff0374f85ec3`.
`pin-manifest.json` remains
`c73dcf2b146da345cf8c017899578152ace03ec3e332b7f881c9d5c892e1482b`,
identical to the independent-pass manifest. The same full-manifest comparison
proves that `artifacts/`, contracts, kernel, service source, the pin manifest,
and historical docs did not change.

## Static review

### UI predicate

`packages/ui/src/app.tsx:251-258` counts only rows satisfying all three
conditions required by D-1:

1. `row.kind === "wake_outcome"`
2. `payload.modelStarted === true`
3. `payload.purpose === "advisor_observation"`

This is the requested explicit reactive predicate. The service implementation
at `packages/service/src/advisor/service.ts:626-636` first rejects non-outcomes
and non-starts, then places `advisor_retrospective` in the retrospective bucket
and the other member of the closed
`"advisor_observation" | "advisor_retrospective"` purpose union in the reactive
bucket. The UI and service are therefore semantically identical for valid
sidecar rows.

The render at `packages/ui/src/app.tsx:866` uses this derived count rather than
`advisorUsage.wakeCount`. No contract, kernel, service-source, or budget
enforcement change was needed because the API already supplies the ledger.

### V-11 regression and mutation proof

`packages/ui/test/a11y.ts:331-399` appends, through the real sidecar API:

- one claimed and consumed reactive observation;
- one claimed and consumed retrospective;
- one claimed reactive wake whose preflight is blocked before model start.

It then requires `1 of 2`. This discriminates the wrong counters:

- claims / old `wakeCount`: 3;
- every guarded model start: 2;
- observation outcomes without the `modelStarted` guard: 2;
- correct consumed reactive units: 1.

I repeated the mutation check in an isolated temporary copy. After rebuilding
that copy with the old
`advisorView.accounting.advisorUsage.wakeCount` expression:

- `2026-07-27T16:42:52Z`–`16:43:24Z`: V-11 failed at
  `a11y.ts:397`, timing out while waiting for
  `Wakes used: 1 of 2 reactive + 1 reserved retrospective`.
- With only the temporary assertion changed to the observed old value
  `3 of 2`, `2026-07-27T16:43:40Z`–`16:43:43Z`: V-11 passed.

An earlier probe before rebuilding the temporary UI was discarded because it
served the copied fixed bundle rather than the mutated source. The rebuilt
probe above is the valid mutation evidence. The temporary copy was removed;
the product source was never mutated for this check.

### Deterministic retry test

`packages/service/test/real-runner-retry.test.ts` accurately pins the
coordinator-side claims made by its comments:

- the recoverable Codex candidate failure pauses with the exact retry/cancel
  action card;
- two pre-failure usage rows exist and remain byte-identical;
- the failed ready item never gets a usage row;
- retry uses one new `resumed` ready item with `chargeBudget: false`;
- six model-wake claims are charged, while the resumed execution is not;
- the resumed burst gets exactly one distinct, causally bound Codex usage row;
- the run completes consensus with six usage rows, zero uncaused invocations,
  the overhead gate passing, the queue drained, and the core hash chain intact;
- exact injected-port call counts are Codex 4 and Claude 3.

This is deterministic coverage only. The live run below had zero
`needs_input` events, so it supplies no real-provider retry verdict.

## Deterministic gates

All accepted gate runs used `env -u ANTHROPIC_BASE_URL`.

| Gate | UTC interval | Result |
|---|---|---|
| `npm run build` | `16:41:13`–`16:41:16` | Exit 0; strict whole-workspace `tsc --noEmit` and Vite 7.1.7 build |
| `npm test` | `16:41:41`–`16:41:51` | Exit 0; 185 Vitest tests plus V-11 |
| `npm run verify:pins` | `16:41:55`–`16:41:57` | Exit 0 |
| `npm run verify:zero-call` | `16:41:55`–`16:41:56` | Exit 0 |

Vitest counts were adapters 34, kernel 44, migration 5, security 4, and service
98: **185 total**. The service count includes the new retry test.

V-11 reported:

```text
RESULT {"suite":"V-11","passed":true,"seriousCriticalViolations":0,
"keyboardComplete":true,"liveRegions":1,"reflowOverflowPx":0,
"eventRenderMs":29.96,"sseDuplicates":0,"restartRestored":true,
"multiRunHistoryRestored":true,"actionCardRestored":true,
"legacyBrowserEscaped":true,"advancedControlsPersisted":true,
"advisorLaneCovered":true,"advisorSameSequenceRefresh":true,
"advisorWakeCounterConsumedUnitsOnly":true,"modelStarts":0}
```

Every deterministic suite's machine-readable result reported
`modelStarts: 0`. The first sandboxed test attempt was environment-blocked at
three temporary `127.0.0.1` listeners plus V-11 (`EPERM`), with no assertion
failure; the accepted rerun above had loopback permission and passed.

Pin verification reported Node 22, `codex-cli 0.146.0-alpha.3.1`, Codex
canonical schema SHA-256
`b5719e63be18118f4231ce6d2d797acd4cddeb801ea44e8aceb4b7860fe6947c`,
97 feature lines, Claude SDK 0.3.220, bundled CLI 2.1.220, and collabd schema
version 2.

The zero-call audit reported 1 guarded Codex turn start, 1 guarded Claude model
query, 1 metadata-only Claude query, 0 forbidden billing calls, and 23
production files audited.

## Real-provider verification

### Launch and bounds

The service was built first and launched as:

```sh
env -u ANTHROPIC_BASE_URL \
  COLLAB_STATE_DIR=/private/tmp/collab-d1-verify-20260727T1644Z \
  COLLAB_PORT=47821 \
  npm start
```

The dashboard was driven through its single-use loopback bootstrap URL. The run
was read-only, network-off for workers, automatic scheduling, capped at 10
minutes, with 8 useful-work bursts per provider, 2 per material challenge, a
Claude high-effort adviser, 2 reactive wake units, and 1 reserved
retrospective. Its goal was a bounded read of `pin-manifest.json`.

Both providers passed the subscription route:

- Codex: ChatGPT Plus, `route=subscription_allowance`; the latest preflight
  recorded `primary.usedPercent=49`.
- Claude: Max, `authMethod=claude.ai`, `apiProvider=firstParty`,
  `includedUsageRemaining=true`, `extraUsageEnabled=false`,
  `existingCreditsRemaining=null`, `route=subscription_allowance`.

The run was created at `2026-07-27T16:45:25.475Z` and reached
`completed_consensus` at `16:48:37.362Z`.

### Wake-counter timeline

| State | Core/sidecar evidence | Authoritative reactive count | Observed UI |
|---|---|---:|---|
| Initial | No `wake_outcome` rows | 0 | `0 of 2 reactive + 1 reserved retrospective` |
| First manual request | `advisor_requested` seq 10 at `16:45:46.062Z`, during both opening bursts | 0 | Still 0 while queued |
| First reactive completed | wake claimed `16:46:04.931Z`; outcome sidecar seq 3 at `16:46:36.194Z`, `modelStarted=1`, `purpose=advisor_observation` | 1 | `1 of 2 reactive + 1 reserved retrospective` |
| Second manual request | `advisor_requested` seq 27 at `16:47:02.353Z`, while a worker burst held the same-provider gate | 1 | Still 1 while queued |
| Second reactive completed | wake claimed `16:47:44.534Z`; outcome sidecar seq 6 at `16:48:16.783Z`, `modelStarted=1`, `purpose=advisor_observation` | 2 | `2 of 2 reactive + 1 reserved retrospective` |
| Terminal retrospective claimed | core completion `16:48:37.362Z`; retrospective claimed `16:48:37.366Z` (4 ms later) | 2 | Still `2 of 2` while retrospective ran |
| Retrospective completed | outcome sidecar seq 9 at `16:49:05.683Z`, `modelStarted=1`, `purpose=advisor_retrospective` | 2 | Final line remained `2 of 2 reactive + 1 reserved retrospective` |

The database-side acceptance query was:

```sql
SELECT
  SUM(CASE WHEN kind = 'wake_outcome'
            AND json_extract(payload_json, '$.modelStarted') = 1
            AND json_extract(payload_json, '$.purpose') =
                'advisor_observation'
           THEN 1 ELSE 0 END) AS reactive_consumed,
  SUM(CASE WHEN kind = 'wake_outcome'
            AND json_extract(payload_json, '$.modelStarted') = 1
            AND json_extract(payload_json, '$.purpose') =
                'advisor_retrospective'
           THEN 1 ELSE 0 END) AS retrospective_consumed
FROM advisor_ledger
WHERE run_id = 'run_4e7a662b-06e3-456b-ad58-450adc1c7fb7';
```

Result: `reactive_consumed=2`, `retrospective_consumed=1`. There were exactly
three guarded adviser model starts, and all had complete usage rows. The final
`advisorUsage.wakeCount` is 3, which independently demonstrates why rendering
that old field against the reactive budget would still have reproduced D-1.

### Final accounting and integrity

- Provider budgets: Codex 3/8; Claude 3/8.
- Worker usage: 6 rows, 250,927 tokens total.
  - Codex: 137,946 tokens
    (`input=69,816`, `cached=65,792`, `output=1,506`, `reasoning=832`).
  - Claude: 112,981 tokens
    (`input=13`, `cached=104,571`, `output=8,397`, `reasoning=0`).
- Adviser usage: 3 separate `advisor_usage` rows, 24,046 Claude tokens
  (`input=6`, `cached=19,052`, `output=4,988`, `reasoning=0`).
- Worker `overhead-gate-v2`: passed by the absolute arm;
  `mixedCoordinatorBytes=13,798` of 49,152,
  ratio `1.058187737476226`, `coordinationTokenUpper=0`.
- Combined worker-plus-adviser ratio was informational only:
  `(250,927 + 24,046) / 237,129 = 1.1596×`.
- Worker and adviser usage coverage: complete.
- Uncaused worker invocations: 0; uncaused adviser wakes: 0.
- Core hash chain: `{ok:true,count:42}`.
- Adviser sidecar hash chain: `{ok:true,count:9}`.
- `needs_input` events: 0.
- No approval events or workspace mutation were observed. The read-only
  provider run left the independent-pass source hash comparison unchanged.

Clean shutdown left no listener on port 47821. The evidence directory is
preserved with the SQLite database and adviser `observations.jsonl`,
`notes.md`, and `retrospective.md`.

## Explicit non-verdicts

- **Retry after a recoverable failure against real providers:** not observed.
  There were zero `needs_input` events, so only the deterministic retry test
  passed.
- **Codex emitting a literal `null` `recommendationCode`:** not observed. The
  live adviser was Claude.
- **Forced provider failure:** not attempted, as requested.
- **V-13 canary:** not run; no authorization file was created or reused.
