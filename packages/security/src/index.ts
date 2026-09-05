import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:Bearer|token)\s+[A-Za-z0-9._~+/-]{16,}=*\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function isContainedPath(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}

export function assertSafeAbsolutePath(path: string, roots: string[]): string {
  if (!path.startsWith("/")) throw new Error("PATH_NOT_ABSOLUTE");
  const normalized = resolve(path);
  if (!roots.some((root) => isContainedPath(root, normalized))) {
    throw new Error("PATH_OUTSIDE_ALLOWED_ROOTS");
  }
  return normalized;
}

/**
 * Strict allowlist of command leaders that cannot mutate the filesystem or
 * reach the network through their own behavior. Anything absent from this
 * list — including wrappers such as `env`, `xargs`, `sudo`, `time` that can
 * smuggle another command — disqualifies the whole command line.
 */
const READ_ONLY_LEADERS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "cd",
  "echo",
  "printf",
  "file",
  "stat",
  "du",
  "df",
  "find",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "which",
  "type",
  "whoami",
  "date",
  "uname",
  "tree",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "column",
  "jq",
  "diff",
  "cmp",
  "shasum",
  "md5",
  "sha256sum",
  "true",
  "test",
  "[",
  "git",
]);

/** Git subcommands that stay read-only regardless of their remaining args. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "shortlog",
  "describe",
  "rev-parse",
  "ls-files",
]);

/** Per-leader flags that turn an otherwise read-only command into a writer. */
const WRITING_FLAGS: Record<string, RegExp> = {
  find: /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf)$/,
  sort: /^(?:-o|--output)/,
  git: /^--output/,
};

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    if ((first === '"' || first === "'") && token.endsWith(first)) {
      return token.slice(1, -1);
    }
  }
  return token;
}

export interface CommandAnalysis {
  /**
   * True only when every segment of the command line is provably read-only.
   * False means "unknown", never "definitely writes" — callers must treat
   * false exactly as conservatively as they treat a mutation today.
   */
  readOnly: boolean;
  /** Resolved path candidates that fall outside the given workspace root. */
  outsidePaths: string[];
  /**
   * True when the command contains constructs (substitution, expansion,
   * redirection to unknown targets) that make its effective paths
   * statically unresolvable. Callers must never grant path-scoped trust —
   * e.g. auto-allowing a deletion as workspace-contained — while this is
   * set.
   */
  unresolvable: boolean;
}

/**
 * Shared scratch locations every developer tool writes to freely. Paths in
 * here are treated as neither workspace-contained nor privacy-relevant:
 * writes are allowed where workspace writes are allowed.
 */
const SCRATCH_ROOTS = [
  "/tmp",
  "/private/tmp",
  resolve(tmpdir()),
  ...(realpathSafe(tmpdir()) ? [realpathSafe(tmpdir())!] : []),
];

function realpathSafe(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function scratchRoots(): string[] {
  return [...SCRATCH_ROOTS];
}

export function isScratchPath(candidate: string): boolean {
  const resolved = resolve(candidate);
  return SCRATCH_ROOTS.some(
    (scratchRoot) =>
      resolved === scratchRoot || resolved.startsWith(`${scratchRoot}${sep}`),
  );
}

/**
 * Conservative shell-command analysis for permission classification and
 * lease scheduling. Both answers err toward safety: a command is read-only
 * only when each pipeline segment starts with an allowlisted leader and the
 * raw text contains no construct that could smuggle another command
 * (redirection, command substitution, variable expansion, backgrounding of
 * unknown text); a token counts as an outside path whenever its resolution
 * cannot be shown to stay inside the workspace.
 */
export function analyzeCommand(command: string, workspace: string): CommandAnalysis {
  const root = resolve(workspace);
  // Redirecting a stream into /dev/null or into another descriptor writes
  // no file; strip those exact forms before scanning for smuggling
  // constructs so `git log 2>/dev/null` stays provable. `$PWD` is
  // statically known — bursts execute with cwd = workspace — so resolve it
  // rather than treating it as an unknown expansion (a `cd` elsewhere in
  // the command surfaces its own path token and is judged separately).
  const raw = String(command ?? "")
    .replace(/\d?>>?\s*\/dev\/null/g, " ")
    .replace(/\d?>&\d/g, " ")
    .replaceAll("${PWD}", root)
    .replaceAll("$PWD", root);
  const outsidePaths = new Set<string>();
  let readOnly = raw.trim().length > 0;

  // Constructs that can redirect output or synthesize commands invisibly.
  const unresolvable = /[<>`]|\$\(|\$\{|\$[A-Za-z_]/.test(raw);
  if (unresolvable) readOnly = false;

  const segments = raw
    .split(/\r?\n|\|\||&&|;|\||&/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) readOnly = false;

  for (const segment of segments) {
    const tokens = segment.split(/\s+/).map(stripQuotes).filter(Boolean);
    if (!tokens.length) {
      readOnly = false;
      continue;
    }
    const leader = tokens[0]!;
    if (!READ_ONLY_LEADERS.has(leader)) readOnly = false;
    if (leader === "git") {
      const subcommand = tokens.find((token, index) => index > 0 && !token.startsWith("-"));
      if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) readOnly = false;
    }
    const writingFlag = WRITING_FLAGS[leader];
    for (const token of tokens.slice(1)) {
      if (writingFlag?.test(token)) readOnly = false;
      if (token.startsWith("-")) continue;
      if (token.startsWith("{")) {
        // Brace expansion can hide absolute paths (`{/etc/passwd,x}`).
        outsidePaths.add(token);
        continue;
      }
      let candidate = token;
      if (candidate.startsWith("~")) {
        candidate = join(homedir(), candidate.slice(1));
      }
      const resolved = resolve(root, candidate);
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
        outsidePaths.add(resolved);
      }
    }
  }
  return { readOnly, outsidePaths: [...outsidePaths].sort(), unresolvable };
}

export function escapeUntrustedText(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
