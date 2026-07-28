import { createHash, randomBytes } from "node:crypto";
import { constantTimeEqual } from "@collab/security";

interface Session {
  token: string;
  csrf: string;
  expiresAt: number;
}

export interface DurableSession {
  tokenHash: string;
  csrfHash: string;
  expiresAt: number;
}

export interface SessionStorage {
  put(session: DurableSession): void;
  get(tokenHash: string): DurableSession | undefined;
  delete(tokenHash: string): void;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class CapabilitySessions {
  readonly capability = randomBytes(32).toString("base64url");
  private consumed = false;
  private readonly sessions = new Map<string, Session>();
  private readonly lifetimeMs: number;

  constructor(
    lifetimeMs = 8 * 60 * 60 * 1000,
    private readonly storage?: SessionStorage,
  ) {
    this.lifetimeMs = lifetimeMs;
  }

  exchange(capability: string): Session {
    if (this.consumed || !constantTimeEqual(this.capability, capability)) {
      throw new Error("CAPABILITY_INVALID_OR_REPLAYED");
    }
    this.consumed = true;
    const token = randomBytes(32).toString("base64url");
    const session = {
      token,
      csrf: randomBytes(24).toString("base64url"),
      expiresAt: Date.now() + this.lifetimeMs,
    };
    this.sessions.set(token, session);
    this.storage?.put({
      tokenHash: hash(token),
      csrfHash: hash(session.csrf),
      expiresAt: session.expiresAt,
    });
    return { ...session };
  }

  validate(token: string | undefined): Session {
    if (!token) throw new Error("SESSION_MISSING");
    const session = this.sessions.get(token);
    if (session && session.expiresAt > Date.now()) return { ...session };
    const durable = this.storage?.get(hash(token));
    if (!durable || durable.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(token);
      if (durable) this.storage?.delete(durable.tokenHash);
      throw new Error("SESSION_INVALID_OR_EXPIRED");
    }
    return { token, csrf: "", expiresAt: durable.expiresAt };
  }

  validateCsrf(token: string | undefined, csrf: string | undefined): Session {
    const session = this.validate(token);
    if (!csrf) throw new Error("CSRF_REJECTED");
    const valid =
      session.csrf !== ""
        ? constantTimeEqual(session.csrf, csrf)
        : constantTimeEqual(this.storage!.get(hash(session.token))!.csrfHash, hash(csrf));
    if (!valid) throw new Error("CSRF_REJECTED");
    return session;
  }

  rotate(token: string): Session {
    const current = this.validate(token);
    this.sessions.delete(token);
    this.storage?.delete(hash(token));
    const next = {
      token: randomBytes(32).toString("base64url"),
      csrf: randomBytes(24).toString("base64url"),
      expiresAt: current.expiresAt,
    };
    this.sessions.set(next.token, next);
    this.storage?.put({
      tokenHash: hash(next.token),
      csrfHash: hash(next.csrf),
      expiresAt: next.expiresAt,
    });
    return { ...next };
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const [key, ...rest] = part.trim().split("=");
      return key ? [[key, decodeURIComponent(rest.join("="))]] : [];
    }),
  );
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `collab_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}
