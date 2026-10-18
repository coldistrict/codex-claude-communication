# Codex + Claude planning

A local place to turn a rough idea, question, decision, planning goal, or existing proposal into a reviewed answer or plan. Describe the goal once. A project folder is optional. Implementing the resulting plan is a separate request.

## Run

Requires Node.js 22, the official Codex desktop runtime at the path in `pin-manifest.json`, and the project-local Claude Agent SDK runtime. Installed dependencies are pinned by `package-lock.json`.

```sh
cd /Users/coldistric/source/repos/codex-claude-communication/product
npm ci
npm run build
npm run doctor
npm start
```

Open the single-use loopback URL printed by `npm start`. Its fragment is exchanged for an HttpOnly, SameSite=Strict session and removed from browser history. The default state directory is `~/Library/Application Support/Collaboration`. `COLLAB_STATE_DIR` selects an isolated state directory; `COLLAB_PORT` optionally selects a port. Starting the service alone starts no model calls.

Both providers must prove an allowed billing route before model work begins. The current tested runtimes are Codex `0.153.1`, Claude Agent SDK `0.3.220`, and its bundled CLI `2.1.220`. Compatibility is measured from the actual binary, generated Codex schema, SDK version, and bundled Claude binary hash. Desktop auto-updates can require renewed compatibility validation. Do not change a pin merely to suppress a failure.

If the official runtime reports a missing Claude login, `npm run login:claude` launches its interactive subscription login. Complete that provider flow and select **Retry preflight**. Unknown plan identifiers, failed metadata reads, changed billing metadata, and usage limits have different diagnostics; they do not automatically mean you are signed out.

## Use

1. Enter a question or rough goal. Optionally choose a project folder (or reuse a recent project). Codex and Claude Code sessions use that working directory, and the folder supplies read-only context. This does not automatically assign sessions to a project in either desktop sidebar. Leaving it blank creates a standalone collaboration.
2. Under **Context and limits**, choose each provider’s model and effort, optionally select text files within that folder, add required conditions, or narrow the call/time budget. Provider default remains available. Explicit model selections are checked against the live provider catalog and never silently replaced. Selections are saved with the run; completed calls record the resolved model in **Messages, provider activity, usage, and diagnostics**.
3. Start collaboration. Answer material clarification cards when they appear.
4. Read the document, assumptions, next steps, review changes, and remaining disagreements. Revisit earlier revisions or saved runs. **Export Markdown** saves `document.md` alongside the event and review history.

The providers first make independent proposals, then cross-review, synthesize, and review the exact revision. A specific material rejection produces a changed document and fresh reviews. One revision cycle is automatic. An answer that does not fit the required structure is re-requested once with the exact reason; that repair call counts toward the budget and is listed in the diagnostics. If it still fails, the run pauses with a plain-language card and **Retry collaboration** resumes at the failed stage. If a specific issue remains, you may authorize one final revision with **Extend budget** and describe that issue. The workflow then stops and preserves any disagreement. It never treats an empty document or unconfirmed required condition as ready.

Provider agreement, task fulfillment, and evidence status are separate. Reviewer judgments are not independent proof that claims are true. Failed incidental checks can be valid audit findings; conceptual plans need not execute commands.

## Context and output boundaries

Planning providers have no filesystem, shell, browser, MCP, or other tools. The service creates a bounded, redacted evidence packet from the brief, selected project's top-level inventory and README, and explicitly selected text files. Both providers receive that same saved packet. Sources are never written by the planning path. Text files are limited to 64 KB each and 160 KB total; omitted binaries or oversized files are identified. Symlinks, changed attachment bytes, and credential file selections fail closed. Add relevant evidence to the brief or selected files; automatic web research is not implemented in this version.

Documents are stored in SQLite's existing hash-chained events and under `<state directory>/documents/<run ID>/`; exports go under `<state directory>/exports/<run ID>/`. Provider sessions use the selected project folder, or `<state directory>/runs/<run ID>/runtime/` when no project is selected. Provider transcripts remain in each provider's normal storage. Sessions receive task-specific titles with the stage and a short run ID; independent proposals and reviews remain separate sessions. Codex desktop project assignment is separate from the working directory. Claude SDK sessions are excluded from the normal session picker; they can be resumed by session ID. Automatic desktop project placement remains incomplete; see `docs/project-routing-2026-09-05.md` for the live acceptance-test failure. Project instructions are not loaded into planning calls. The service, rather than either model, writes document files. The optional adviser remains outside the default planning path. Historical execution runs, exports, and optional read-only legacy task browsing remain available. Existing native sessions are not moved or renamed by this change; a retried planning run uses its saved project for new calls.

Billing follows the recorded project policy: subscription allowance first, then only proven existing provider-managed prepaid credits. Claude's monthly spending cap is not evidence of prepaid funds; when the bundled metadata cannot prove that route, the app stops at the subscription limit. The app never selects API credentials, switches billing routes to bypass a failure, purchases credits, enables top-ups, or consumes reset credits. Official subscription authentication stays with the providers.

## Verification and evaluation

After installing dependencies, install the pinned Playwright browser once for the browser tests (the browser cache is not stored in Git):

```sh
PLAYWRIGHT_BROWSERS_PATH=.playwright npx playwright install chromium
```

```sh
npm run verify:pins
npm test
npm run verify:zero-call
npm run doctor
npm run verify:planning-ui
npm run verify:ui-regressions
npm run evaluate:planning
```

The regular suites use isolated deterministic fixtures and start zero models. `doctor` only probes runtime/authentication/billing metadata. The planning UI check uses a real browser with fake provider ports; its evidence is explicitly labeled.

For an interactive UI preview after building, run `node --import tsx tools/ui-preview.ts` and open its single-use launch URL. This serves deterministic planning fixtures on loopback port 3002 with temporary state and zero model calls. The UI regression suite covers form recovery, draft preservation, revision status, delayed responses, keyboard focus, and responsive accessibility. See [the UI review](docs/ui-review-2026-09-05.md) for findings and screenshots.

`evaluate:planning` prepares four cases and a protocol comparing a single answer, self-review, and the two-provider workflow. It starts no models. Live comparisons require a separate explicit, expiring authorization and call budget; the implementation smoke budget does not authorize a full benchmark. It records consumption, latency, corrections, unsupported claims, and anonymous outputs with blank human-rating fields. Keep `condition-key.json` hidden during human review. No improvement or user preference is inferred from agreement, test passes, or overhead ratios.

See [the implementation report](docs/planning-implementation-2026-09-04.md) for verified results and limitations, and [the live testing notes](docs/live-testing-2026-09-05.md) for the most recent real-provider runs and the structured-output repair they led to. The [earlier assessment](docs/product-assessment-2026-09-04.md) and historical evidence remain unchanged.
