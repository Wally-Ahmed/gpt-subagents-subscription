import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { OAUTH_CLIENT_ID, OAUTH_TOKEN_URL, TOKEN_DIR, TOKEN_FILE } from "./config.js";
import type { Auth, StoredTokens } from "./config.js";

const REFRESH_SKEW_MS = 60_000;

export class NotAuthenticatedError extends Error {
  constructor(msg = "Not authenticated — run `npm run login` first.") {
    super(msg);
    this.name = "NotAuthenticatedError";
  }
}

// Validate the on-disk shape at runtime. JSON.parse gives us `any`, so a
// corrupt/partial file must not be trusted just because it parsed.
function isValidStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.access_token === "string" &&
    t.access_token.length > 0 &&
    typeof t.refresh_token === "string" &&
    t.refresh_token.length > 0 &&
    typeof t.account_id === "string" &&
    t.account_id.length > 0 &&
    typeof t.expires_at === "number" &&
    Number.isFinite(t.expires_at) &&
    (t.id_token === undefined || typeof t.id_token === "string")
  );
}

export function loadTokens(): StoredTokens | null {
  let raw: string;
  try {
    raw = readFileSync(TOKEN_FILE, "utf8");
  } catch (err) {
    // Missing file is the normal "not logged in" state; anything else
    // (permission denied, I/O error) is a real problem we must not hide.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Token file is corrupt (invalid JSON): ${TOKEN_FILE}`);
  }
  if (!isValidStoredTokens(parsed)) {
    throw new Error(`Token file is corrupt (unexpected shape): ${TOKEN_FILE}`);
  }
  return parsed;
}

// Ensure TOKEN_DIR exists, is a real directory (not a symlink), and is 0700.
// mkdir's `mode` only applies on create, so we always lstat + chmod to tighten
// a pre-existing directory and to refuse a symlink planted at that path.
function ensureSecureTokenDir(): void {
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const st = lstatSync(TOKEN_DIR);
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to use token dir: ${TOKEN_DIR} is a symlink`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Refusing to use token dir: ${TOKEN_DIR} is not a directory`);
  }
  chmodSync(TOKEN_DIR, 0o700);
}

export function saveTokens(tokens: StoredTokens): void {
  ensureSecureTokenDir();
  // Atomic write: create a fresh temp file (wx => fail if it exists, never
  // follow a symlink) with 0600, then rename over TOKEN_FILE. Rename replaces a
  // symlink at TOKEN_FILE instead of writing through it, and never leaves a
  // half-written auth.json behind.
  const tmp = join(TOKEN_DIR, `auth.json.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(tmp, TOKEN_FILE);
  } catch (err) {
    // Best-effort cleanup so a failed write doesn't leak temp files.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

export function clearTokens(): void {
  rmSync(TOKEN_FILE, { force: true });
}

export async function refreshTokens(current: StoredTokens): Promise<StoredTokens> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: current.refresh_token,
    }),
  });
  if (!res.ok) {
    throw new NotAuthenticatedError(
      `Session expired and refresh failed (${res.status}) — run \`npm run login\` again.`
    );
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new NotAuthenticatedError(
      "Refresh response was not valid JSON — run `npm run login` again."
    );
  }
  const d = (data ?? {}) as Record<string, unknown>;
  // The provider's response is untrusted: validate before persisting so a
  // malformed body can't poison the stored token (NaN expiry, blank access).
  if (typeof d.access_token !== "string" || d.access_token.length === 0) {
    throw new NotAuthenticatedError(
      "Refresh response missing access_token — run `npm run login` again."
    );
  }
  if (typeof d.expires_in !== "number" || !Number.isFinite(d.expires_in) || d.expires_in <= 0) {
    throw new NotAuthenticatedError(
      "Refresh response had an invalid expires_in — run `npm run login` again."
    );
  }
  // A rotated refresh_token must be a non-empty string to be accepted; an empty
  // string is treated as "not provided" so we keep the current one.
  let nextRefresh = current.refresh_token;
  if (d.refresh_token !== undefined) {
    if (typeof d.refresh_token !== "string") {
      throw new NotAuthenticatedError(
        "Refresh response had an invalid refresh_token — run `npm run login` again."
      );
    }
    if (d.refresh_token.length > 0) nextRefresh = d.refresh_token;
  }
  return {
    ...current,
    access_token: d.access_token,
    refresh_token: nextRefresh,
    expires_at: Date.now() + d.expires_in * 1000,
  };
}

// Serialize concurrent refreshes. MCP tool handlers run concurrently and each
// calls getValidAuth(); without this, two overlapping calls would each POST the
// same (possibly single-use) refresh_token, racing token rotation. Awaiters
// share one in-flight refresh and re-read tokens from disk afterward.
let refreshInFlight: Promise<void> | null = null;

function needsRefresh(tokens: StoredTokens): boolean {
  // Non-finite expiry is treated as "must refresh" (defensive; loadTokens
  // already rejects it, but a token built in-process should still be safe).
  if (!Number.isFinite(tokens.expires_at)) return true;
  return Date.now() >= tokens.expires_at - REFRESH_SKEW_MS;
}

export async function getValidAuth(): Promise<Auth> {
  let current = loadTokens();
  if (!current) throw new NotAuthenticatedError();

  if (needsRefresh(current)) {
    if (!refreshInFlight) {
      const toRefresh = current;
      refreshInFlight = (async () => {
        const refreshed = await refreshTokens(toRefresh);
        saveTokens(refreshed);
      })().finally(() => {
        refreshInFlight = null;
      });
    }
    await refreshInFlight;
    // Re-read so every awaiter observes the freshly persisted token.
    current = loadTokens();
    if (!current) throw new NotAuthenticatedError();
  }

  return { accessToken: current.access_token, accountId: current.account_id };
}
