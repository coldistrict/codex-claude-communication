import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { URL } from "node:url";
import { EventStore } from "@collab/kernel";
import {
  exportRun,
  listLegacyTasks,
  readConfiguredLegacyTask,
} from "@collab/migration";
import { redactSecrets } from "@collab/security";
import { CapabilitySessions, parseCookies, sessionCookie } from "./auth.ts";
import { Coordinator, type CreateRunInput } from "./coordinator.ts";
import { composeModelAccounting } from "./advisor/accounting.ts";
import { ProviderExecutionGate } from "./advisor/execution-gate.ts";
import { AdvisorNotes } from "./advisor/notes.ts";
import { AdvisorService, realAdvisorPorts } from "./advisor/service.ts";
import { composeOverheadView } from "./overhead-notice.ts";
import {
  readMacMemoryPressure,
  ResourceGovernor,
  type ResourceSample,
} from "./resources.ts";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export interface CollabServerOptions {
  stateFile: string;
  uiDirectory?: string;
  /**
   * Enables the read-only legacy browser for immediate child task folders.
   * There is intentionally no request parameter that can select another
   * filesystem root.
   */
  legacyTasksRoot?: string;
  sessionLifetimeMs?: number;
  codexBinary?: string;
  environment?: NodeJS.ProcessEnv;
  /**
   * Enables the deterministic `fixture` parameter on the retry-preflight
   * route. Off by default: the shipped API must not accept fabricated
   * preflight fixtures; deterministic suites opt in explicitly.
   */
  developmentFixtures?: boolean;
}

function contentType(path: string): string {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".json": "application/json; charset=utf-8",
    }[extname(path)] ?? "application/octet-stream"
  );
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  response.end(data);
}

async function readBody(request: IncomingMessage, limit = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createCollabServer(options: CollabServerOptions) {
  const legacyTasksRoot = options.legacyTasksRoot
    ? realpathSync(options.legacyTasksRoot)
    : null;
  if (legacyTasksRoot && !statSync(legacyTasksRoot).isDirectory()) {
    throw new Error("LEGACY_ROOT_NOT_DIRECTORY");
  }
  const store = new EventStore(options.stateFile);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS security_sessions (
      token_hash TEXT PRIMARY KEY,
      csrf_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  const sessions = new CapabilitySessions(options.sessionLifetimeMs, {
    put(session) {
      store.db
        .prepare(
          `INSERT INTO security_sessions(token_hash, csrf_hash, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(token_hash) DO UPDATE SET csrf_hash=excluded.csrf_hash, expires_at=excluded.expires_at`,
        )
        .run(session.tokenHash, session.csrfHash, session.expiresAt);
    },
    get(tokenHash) {
      const row = store.db
        .prepare(
          "SELECT token_hash AS tokenHash, csrf_hash AS csrfHash, expires_at AS expiresAt FROM security_sessions WHERE token_hash=?",
        )
        .get(tokenHash) as
        | { tokenHash: string; csrfHash: string; expiresAt: number }
        | undefined;
      return row;
    },
    delete(tokenHash) {
      store.db.prepare("DELETE FROM security_sessions WHERE token_hash=?").run(tokenHash);
    },
  });
  const resources = new ResourceGovernor();
  const subscribers = new Set<ServerResponse>();
  let actualPort = 0;
  let memoryPressure: ResourceSample["memoryPressure"] = "unknown";
  const refreshMemoryPressure = async () => {
    memoryPressure = await readMacMemoryPressure();
  };
  void refreshMemoryPressure();
  const memoryPressureInterval = setInterval(() => {
    void refreshMemoryPressure();
  }, 5_000);
  memoryPressureInterval.unref();
  let expectedResourceTick = performance.now() + 1_000;
  const resourceInterval = setInterval(() => {
    const now = performance.now();
    const state = resources.sample({
      rssBytes: process.memoryUsage().rss,
      memoryPressure,
      eventLoopLagMs: Math.max(0, now - expectedResourceTick),
    });
    expectedResourceTick = now + 1_000;
    // Edge-detected inside the adviser service; this is the existing sampler,
    // not a new poll loop.
    advisorService.noteResourceState({
      degraded: state.degraded,
      admitHeavyWork: state.admitHeavyWork,
    });
  }, 1_000);
  resourceInterval.unref();

  function expectedOrigin(request: IncomingMessage): string {
    return `http://${request.headers.host}`;
  }

  function validHost(request: IncomingMessage): boolean {
    const host = request.headers.host ?? "";
    return (
      host === `127.0.0.1:${actualPort}` ||
      host === `localhost:${actualPort}` ||
      (actualPort === 0 && /^(?:127\.0\.0\.1|localhost):\d+$/.test(host))
    );
  }

  function requireOrigin(request: IncomingMessage): void {
    if (!validHost(request) || request.headers.origin !== expectedOrigin(request)) {
      throw new Error("ORIGIN_OR_HOST_REJECTED");
    }
  }

  function sessionFor(request: IncomingMessage, mutating = false) {
    const token = parseCookies(request.headers.cookie).collab_session;
    if (mutating) {
      requireOrigin(request);
      return sessions.validateCsrf(
        token,
        typeof request.headers["x-collab-csrf"] === "string"
          ? request.headers["x-collab-csrf"]
          : undefined,
      );
    }
    return sessions.validate(token);
  }

  function publish(runId: string): void {
    const projection = projectionForView(runId);
    const payload = `event: projection\ndata: ${JSON.stringify(projection)}\n\n`;
    for (const subscriber of subscribers) subscriber.write(payload);
  }

  function projectionForView(runId: string) {
    const projection = store.projection(runId);
    return {
      ...projection,
      overhead: composeOverheadView(projection, store.usageRecords(runId)),
    };
  }

  const codexBinary =
    options.codexBinary ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
  const providerExecutionGate = new ProviderExecutionGate();
  const advisorService = new AdvisorService(store, {
    stateRoot: dirname(options.stateFile),
    publish,
    resourceState: () => {
      const state = resources.current();
      return { admitHeavyWork: state.admitHeavyWork, degraded: state.degraded };
    },
    ports: realAdvisorPorts({
      codexBinary,
      ...(options.environment ? { environment: options.environment } : {}),
    }),
    executionGate: providerExecutionGate,
  });
  store.appendListener = (event) => advisorService.noteEvent(event);
  const coordinator = new Coordinator(store, {
    codexBinary,
    ...(options.environment ? { environment: options.environment } : {}),
    resourceState: () => resources.current(),
    publish,
    advisor: {
      hooks: {
        noteProviderRuntimeActivity: (runId, role) =>
          advisorService.noteProviderRuntimeActivity(runId, role),
        noteProviderFailure: (runId, role, stage, message) =>
          advisorService.noteProviderFailure(runId, role, stage, message),
        noteProviderSuccess: (runId, role) =>
          advisorService.noteProviderSuccess(runId, role),
        noteBrowserIdentityDegraded: (runId, role, burstKey) =>
          advisorService.noteBrowserIdentityDegraded(runId, role, burstKey),
        noteWorkerBurstSettled: (runId) =>
          advisorService.noteWorkerBurstSettled(runId),
      },
      setWorkerBurstProbe: (probe) => advisorService.setWorkerBurstProbe(probe),
      providerExecutionGate,
    },
  });

  const server = createServer(async (request, response) => {
    response.setHeader("Content-Security-Policy", CSP);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    try {
      if (!validHost(request)) throw new Error("HOST_REJECTED");
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, { ok: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/bootstrap") {
        requireOrigin(request);
        const body = await readBody(request);
        const session = sessions.exchange(String(body.capability ?? ""));
        response.setHeader("Set-Cookie", sessionCookie(session.token, Math.floor((session.expiresAt - Date.now()) / 1000)));
        json(response, 200, { csrf: session.csrf, expiresAt: session.expiresAt });
        return;
      }
      if (request.method === "POST" && url.pathname === "/session/restore") {
        requireOrigin(request);
        const currentToken = parseCookies(request.headers.cookie).collab_session;
        sessions.validate(currentToken);
        const session = sessions.rotate(currentToken!);
        response.setHeader("Set-Cookie", sessionCookie(session.token, Math.floor((session.expiresAt - Date.now()) / 1000)));
        json(response, 200, { csrf: session.csrf, expiresAt: session.expiresAt });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/runs") {
        sessionFor(request);
        json(
          response,
          200,
          store.listRunIds().map((runId) => projectionForView(runId)),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/system") {
        sessionFor(request);
        json(response, 200, {
          ...resources.current(),
          legacyTasksEnabled: legacyTasksRoot !== null,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/legacy-tasks") {
        sessionFor(request);
        if (!legacyTasksRoot) {
          json(response, 404, { error: "LEGACY_TASKS_DISABLED" });
          return;
        }
        json(response, 200, listLegacyTasks(legacyTasksRoot));
        return;
      }
      const legacyMatch = url.pathname.match(/^\/api\/legacy-tasks\/([^/]+)$/);
      if (request.method === "GET" && legacyMatch) {
        sessionFor(request);
        if (!legacyTasksRoot) {
          json(response, 404, { error: "LEGACY_TASKS_DISABLED" });
          return;
        }
        const id = decodeURIComponent(legacyMatch[1]!);
        const task = readConfiguredLegacyTask(legacyTasksRoot, id);
        json(response, 200, {
          id,
          name: task.name,
          state: task.state,
          goal: task.goal,
          notes: task.notes,
          transcript: task.transcript,
          finalPlan: task.finalPlan,
          files: task.files,
          readOnly: true,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/runs") {
        sessionFor(request, true);
        const input = (await readBody(request)) as CreateRunInput;
        const runId = coordinator.createRun(input);
        publish(runId);
        json(response, 201, projectionForView(runId));
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch) {
        sessionFor(request);
        const runId = runMatch[1]!;
        const projection = projectionForView(runId);
        if (!projection.goal) {
          json(response, 404, { error: "RUN_NOT_FOUND" });
          return;
        }
        json(response, 200, projection);
        return;
      }
      const retryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/retry-preflight$/);
      if (request.method === "POST" && retryMatch) {
        sessionFor(request, true);
        const body = await readBody(request);
        if (body.fixture) {
          if (!options.developmentFixtures) {
            throw new Error("FIXTURE_PREFLIGHT_DISABLED");
          }
          const result = coordinator.retryPreflight(retryMatch[1]!, body.provider, body.fixture);
          publish(retryMatch[1]!);
          json(response, 200, result);
        } else {
          coordinator.retryRealPreflight(retryMatch[1]!);
          json(response, 202, { scheduled: true });
        }
        return;
      }
      const exportMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/export$/);
      if (request.method === "POST" && exportMatch) {
        sessionFor(request, true);
        const runId = decodeURIComponent(exportMatch[1]!);
        if (!store.projection(runId).goal) {
          json(response, 404, { error: "RUN_NOT_FOUND" });
          return;
        }
        const destination = join(
          dirname(options.stateFile),
          "exports",
          runId.replaceAll(/[^A-Za-z0-9_-]/g, "_"),
        );
        const advisorEnabled =
          store.projection(runId).goal?.advisor?.enabled === true;
        const exported = exportRun(store, runId, destination, {
          ...(advisorEnabled
            ? {
                advisorDirectory: join(
                  dirname(options.stateFile),
                  "runs",
                  runId.replaceAll(/[^A-Za-z0-9_-]/g, "_"),
                  "advisor",
                ),
              }
            : {}),
        });
        json(response, 200, { destination, ...exported });
        return;
      }
      const advisorMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/advisor$/);
      if (request.method === "GET" && advisorMatch) {
        sessionFor(request);
        const runId = decodeURIComponent(advisorMatch[1]!);
        const projection = store.projection(runId);
        if (!projection.goal) {
          json(response, 404, { error: "RUN_NOT_FOUND" });
          return;
        }
        const config = projection.goal.advisor ?? null;
        if (!config?.enabled) {
          json(response, 200, { enabled: false });
          return;
        }
        const accounting = composeModelAccounting(store, advisorService.sidecar, runId);
        let files: Array<{ name: string; path: string; sha256: string; size: number }> = [];
        try {
          files = new AdvisorNotes(dirname(options.stateFile), runId).files();
        } catch {
          files = [];
        }
        json(response, 200, {
          enabled: true,
          config,
          ledger: advisorService.sidecar.rows(runId),
          accounting,
          files,
          projectionAdvisor: projection.advisor ?? null,
        });
        return;
      }
      const advisorAskMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/advisor\/ask$/,
      );
      if (request.method === "POST" && advisorAskMatch) {
        sessionFor(request, true);
        coordinator.requestAdvisor(decodeURIComponent(advisorAskMatch[1]!));
        json(response, 202, { requested: true });
        return;
      }
      const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        sessionFor(request, true);
        await coordinator.cancelRun(cancelMatch[1]!);
        publish(cancelMatch[1]!);
        json(response, 200, projectionForView(cancelMatch[1]!));
        return;
      }
      const actionMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/actions\/([^/]+)$/,
      );
      if (request.method === "POST" && actionMatch) {
        sessionFor(request, true);
        const body = await readBody(request);
        await coordinator.decideAction(
          decodeURIComponent(actionMatch[1]!),
          decodeURIComponent(actionMatch[2]!),
          String(body.action ?? ""),
          typeof body.details === "string" ? body.details : "",
        );
        publish(actionMatch[1]!);
        json(response, 200, projectionForView(actionMatch[1]!));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        sessionFor(request);
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write("event: ready\ndata: {}\n\n");
        subscribers.add(response);
        request.on("close", () => subscribers.delete(response));
        return;
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
        const relativePath = url.pathname === "/" ? "index.html" : normalize(url.pathname.slice(1));
        if (relativePath.includes("..")) throw new Error("PATH_TRAVERSAL");
        const path = options.uiDirectory ? join(options.uiDirectory, relativePath) : "";
        if (!path || !existsSync(path) || !statSync(path).isFile()) {
          const fallback =
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Collaboration</title></head><body><main><h1>Collaboration dashboard</h1><p>Build the UI bundle with npm run build.</p></main></body></html>";
          response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": Buffer.byteLength(fallback),
            "Cache-Control": "no-store",
          });
          response.end(fallback);
          return;
        }
        response.writeHead(200, {
          "Content-Type": contentType(path),
          "Content-Length": statSync(path).size,
          "Cache-Control": relativePath === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
        });
        createReadStream(path).pipe(response);
        return;
      }
      json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      const unauthorized =
        message.includes("SESSION") ||
        message.includes("CAPABILITY") ||
        message.includes("ORIGIN") ||
        message.includes("HOST") ||
        message.includes("CSRF");
      json(response, unauthorized ? 403 : 400, { error: message });
    }
  });

  return {
    server,
    sessions,
    store,
    coordinator,
    resources,
    advisorService,
    publish,
    async listen(port = 0): Promise<{ port: number; url: string; launchUrl: string }> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("INVALID_SERVER_ADDRESS");
      actualPort = address.port;
      const url = `http://127.0.0.1:${actualPort}`;
      return { port: actualPort, url, launchUrl: `${url}/#${sessions.capability}` };
    },
    async close(): Promise<void> {
      clearInterval(resourceInterval);
      clearInterval(memoryPressureInterval);
      await advisorService.shutdown();
      for (const subscriber of subscribers) subscriber.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
