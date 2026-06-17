import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { OAUTH_CLIENT_ID, OAUTH_TOKEN_URL, TOKEN_DIR, TOKEN_FILE } from "./config.js";
import type { Auth, StoredTokens } from "./config.js";

const REFRESH_SKEW_MS = 60_000;

export class NotAuthenticatedError extends Error {
  constructor(msg = "Not authenticated — run `npm run login` first.") {
    super(msg);
    this.name = "NotAuthenticatedError";
  }
}

export function loadTokens(): StoredTokens | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as StoredTokens;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: StoredTokens): void {
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
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
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    ...current,
    access_token: data.access_token,
    refresh_token: data.refresh_token || current.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export async function getValidAuth(): Promise<Auth> {
  const current = loadTokens();
  if (!current) throw new NotAuthenticatedError();
  let tokens = current;
  if (Date.now() >= tokens.expires_at - REFRESH_SKEW_MS) {
    tokens = await refreshTokens(tokens);
    saveTokens(tokens);
  }
  return { accessToken: tokens.access_token, accountId: tokens.account_id };
}
