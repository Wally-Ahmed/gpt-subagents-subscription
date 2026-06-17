import crypto from "node:crypto";
import http from "node:http";
import {
  OAUTH_AUTHORIZE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPES,
  OAUTH_TOKEN_URL,
  REDIRECT_PORT,
  REDIRECT_URI,
  EXTRA_AUTHORIZE_PARAMS,
} from "./config.js";
import type { StoredTokens } from "./config.js";

// How long to wait for the browser to redirect back with the auth code before
// giving up and tearing down the loopback callback server.
const LOGIN_CALLBACK_TIMEOUT_MS = 5 * 60_000;

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(opts: { challenge: string; state: string }): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    state: opts.state,
    ...EXTRA_AUTHORIZE_PARAMS,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;
};

function decodeJwtPayload(jwt: string): Record<string, any> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("Malformed id_token");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

// Lightweight, defense-in-depth claim checks on the id_token. The token arrives
// directly from auth.openai.com over TLS (not via the browser redirect), so we
// do NOT do full JWKS signature verification here — that is intentionally
// deferred. We only assert the issuer is an OpenAI host and the token has not
// already expired, to reject an obviously wrong/stale token early.
function validateIdTokenClaims(payload: Record<string, any>): void {
  const iss = payload.iss;
  if (typeof iss !== "string") {
    throw new Error("id_token missing issuer (iss)");
  }
  let host: string;
  try {
    host = new URL(iss).hostname;
  } catch {
    throw new Error("id_token issuer (iss) is not a valid URL");
  }
  if (host !== "openai.com" && !host.endsWith(".openai.com")) {
    throw new Error(`id_token issuer is not an openai.com host: ${host}`);
  }
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new Error("id_token missing or invalid expiry (exp)");
  }
  if (exp * 1000 <= Date.now()) {
    throw new Error("id_token has already expired");
  }
  // NOTE: signature verification against OpenAI's JWKS is deliberately not
  // performed here (no JWKS/crypto dependency); see comment above.
}

// The exact claim path is reverse-engineered; we check the known locations. [VERIFY-LIVE]
export function parseAccountId(idToken: string): string {
  const p = decodeJwtPayload(idToken);
  validateIdTokenClaims(p);
  const id =
    p["https://api.openai.com/auth"]?.chatgpt_account_id ??
    p.chatgpt_account_id ??
    p.account_id;
  if (!id || typeof id !== "string") {
    throw new Error(
      "Could not find chatgpt_account_id in id_token (claim path may have changed)"
    );
  }
  return id;
}

export async function exchangeCode(opts: {
  code: string;
  verifier: string;
}): Promise<TokenResponse> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OAUTH_CLIENT_ID,
      code: opts.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: opts.verifier,
    }),
  });
  if (!res.ok) {
    // Don't echo the raw OAuth error body (it can carry sensitive diagnostics);
    // surface only the status and a short, parsed error_description if present.
    let detail = "";
    try {
      const body = (await res.json()) as { error_description?: unknown; error?: unknown };
      const desc = body.error_description ?? body.error;
      if (typeof desc === "string" && desc.length > 0) {
        detail = `: ${desc.slice(0, 200)}`;
      }
    } catch {
      /* non-JSON body — omit it entirely */
    }
    throw new Error(`Token exchange failed (${res.status})${detail}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function runLoginFlow(): Promise<StoredTokens> {
  const { verifier, challenge } = generatePkce();
  const state = crypto.randomBytes(16).toString("hex");
  const authorizeUrl = buildAuthorizeUrl({ challenge, state });

  const code = await new Promise<string>((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;

    // Single, idempotent settlement path: close the server and clear the
    // timeout exactly once, so a stray request, a late `error` event, or the
    // timeout can't double-settle or close twice.
    const finish = (err: Error | null, value?: string) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(value as string);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "", `http://127.0.0.1:${REDIRECT_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      // Wrong/absent state => stray hit (stale tab, probe, double-fire). Reject
      // THIS request with 400 but keep listening for the real callback.
      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          "<h1>Ignored</h1><p>State mismatch — this is not the expected sign-in callback.</p>"
        );
        return;
      }
      // State matched: this is the real callback. A missing code is a terminal
      // OAuth failure (e.g. the provider returned ?error=...).
      if (!returnedCode) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          "<h1>Login failed</h1><p>No authorization code was returned. You can close this tab.</p>"
        );
        const oauthError = url.searchParams.get("error");
        finish(
          new Error(
            oauthError
              ? `OAuth callback returned an error: ${oauthError}`
              : "OAuth callback missing authorization code"
          )
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Logged in</h1><p>You can close this tab and return to the terminal.</p>"
      );
      finish(null, returnedCode);
    });
    server.on("error", (err) => finish(err));
    // Bind to loopback only so the callback server is never reachable from the
    // LAN (a host-less listen binds all interfaces).
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      console.error(
        `\nTo sign in, open this URL in a browser where you're already signed in to ChatGPT:\n\n${authorizeUrl}\n\nWaiting for the sign-in callback on http://127.0.0.1:${REDIRECT_PORT} ...\n`
      );
    });
    // Don't hang forever if the user never completes sign-in.
    timer = setTimeout(() => {
      finish(new Error("Timed out waiting for the OAuth callback (5 minutes)."));
    }, LOGIN_CALLBACK_TIMEOUT_MS);
  });

  const tok = await exchangeCode({ code, verifier });
  if (!tok.id_token) throw new Error("No id_token returned; cannot determine account id");
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    id_token: tok.id_token,
    account_id: parseAccountId(tok.id_token),
    expires_at: Date.now() + tok.expires_in * 1000,
  };
}
