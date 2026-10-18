# Project placement for consensus sessions

**Acceptance status: FAILED.** A subsequent live run verified folder/title persistence but disproved automatic desktop project placement. The requested native sidebar integration remains incomplete. See the live acceptance check below.

The existing project picker supplied evidence, but the planning runner always created Codex and Claude Code sessions in an internal `runs/<id>/runtime` directory. Every stage also inherited a generic native title from the same first prompt.

New provider sessions now use the run's canonical, saved project folder. Projectless runs retain their separate internal directories. The selected folder is checked again on retry; an unavailable or redirected folder stops before provider startup. Documents and exports stay in the service state directory, and project sources remain read-only.

Both providers receive a compact title made from the user brief, stage, revision when applicable, repair indicator, and short run ID. Codex uses `thread/name/set` before generation; Claude's pinned SDK supports the `title` query option and persistent sessions. Calls stay independent: no proposal or review resumes another stage's session.

The composer explains project placement and offers recent folders from saved runs, including after restart. Project names appear in history and the run header; full paths remain available in the picker and title attributes. Choose the same directory used by the native project's workspace. This does not register a new project in either desktop app or move existing native history.

Codex's planning-only `project_doc_max_bytes: 0` prevents the chosen directory from adding AGENTS.md instructions to the shared evidence packet. Claude retains empty setting sources and a custom system prompt. Existing tool restrictions remain in place.

## Verification

- Build and TypeScript checks passed.
- 50 focused adapter, planning, model-selection, and project-routing tests passed. The new coverage checks both providers' cwd/title settings, projectless isolation, unchanged source files, retry behavior, and compact stage titles.
- All workspace unit suites passed across the initial run and the retry of tests requiring loopback access. The initial sandbox denied localhost listeners; the affected 11 service tests passed with loopback access enabled.
- The existing V-11 UI/accessibility suite passed with zero model starts.
- The new `tools/project-routing-browser.ts` browser check passed: mocked folder-picker integration, recent-project reuse, restart persistence, project labels, source preservation, and 320/390/1360px composer layouts, with no serious or critical accessibility violations. The fixture does not exercise the operating-system folder dialog or native provider sidebars.
- The zero-call audit and whitespace checks passed.
- The idle local service was reloaded at `http://127.0.0.1:3005`, using the same database. All five saved run projections remained byte-identical, and HTTP verification confirmed the updated UI bundle was served. See `artifacts/project-routing-2026-09-05/service-reload.json`.

Provider calls in tests were deterministic fixtures or mocked adapters. No live model call was made, and actual placement of a newly generated conversation in the native Codex/Claude Code interfaces was not exercised in this verification. The implementation uses the documented project-directory and session-title APIs, verified against the installed types and generated Codex schema.

## Subsequent computer-use check

Following the user's request, the running app at port 3005 was exercised through `cua_repl`, separately from Playwright test scripts. Opening New collaboration, selecting the saved recent project, manually entering a different project path, and closing/reopening the draft all worked. The selected path and draft text were visibly preserved. Reloading retained access and the five existing saved runs. No collaboration was submitted and no model call started; the test draft was cleared afterward.

The native Choose folder button launched its `osascript` subprocess, but that standalone dialog was not exposed as a controllable app by the computer-use tool. Finder access did not reveal it, and directly selecting the executable returned Invalid app. The test-created picker subprocess was terminated to release the busy button, and the app visibly recovered. Native folder selection therefore remains unverified by computer use. This is a tooling limitation, not evidence that a person cannot operate the dialog. Actual newly generated session placement in Codex and Claude Code also remains unverified end to end.

## Live acceptance check

On September 5, 2026, Computer Use submitted `run_541d4263-9ddd-4205-8c7b-69e94b5e687a` through the running app with the existing `codex-claude-communication` project folder. The brief requested a bounded two-session documentation review plan, with Sol and Opus at medium effort, an eight-minute limit, and ten maximum calls. Both providers used subscription allowance. The run reached `completed_consensus` after seven calls (58,544 tokens; 107 seconds of provider activity), with both approving the final document. Computer Use verified the project-labelled history entry and exported the run. Evidence is in `artifacts/project-routing-2026-09-05/live-result.json` and `live-export/`.

The acceptance check found two failures:

- The official Codex app `list_threads` tool returned four task-specific sessions with the expected cwd, but all four had `projectId: null` and appeared in the general Tasks section. The chosen directory is a saved Codex project. Local read-only inspection of the installed desktop code confirms that project assignment is separate application state. The available app-server methods set cwd/name but do not expose desktop project assignment. Computer Use explicitly denied access to the Codex native app, so its UI could not be tested or used to move the sessions.
- Claude's official SDK listed three persisted sessions with the expected cwd and titles. All three disappeared with `includeProgrammatic: false`; Computer Use also found none in the Claude Code desktop project's sidebar. Official documentation confirms that SDK sessions are excluded from the standard CLI session picker and that Desktop has separate history. The documented `/desktop` handoff may support an explicit transfer, but reopening the test session with the standalone CLI stopped at interactive onboarding/sign-in. Both test CLI processes were exited without sending a model prompt; this transfer remains unverified.

The misleading UI and README promise of automatic desktop placement was removed, and the build passed again. The final Computer Use refresh was blocked because the Mac had locked and the tool could not unlock it. Folder selection and titles are useful partial behavior, but they do not satisfy the requested destination feature. Completion requires supported native project assignment/transfer and a repeat test proving visibility and reopening in both destination apps. The native folder dialog also remains unverified by Computer Use.

## Provider references

- [Codex app-server threads](https://developers.openai.com/codex/app-server#threads): thread working directories and names.
- [Codex configuration reference](https://developers.openai.com/codex/config-reference): project instruction byte limit.
- [Claude Code Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions): persistent sessions and directory-based history.
- [Claude session management](https://code.claude.com/docs/en/sessions): SDK sessions require explicit resume by session ID and are omitted from the normal picker.
- [Claude Desktop, coming from the CLI](https://code.claude.com/docs/en/desktop#coming-from-the-cli): separate histories and the `/desktop` transfer command.
- Installed Claude Agent SDK `0.3.220` declares `Options.title` in `sdk.d.ts`; the pinned Codex schema declares `ThreadSetNameParams` with `threadId` and `name`.
