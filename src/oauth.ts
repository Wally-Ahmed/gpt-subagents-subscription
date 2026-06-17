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

// The exact claim path is reverse-engineered; we check the known locations. [VERIFY-LIVE]
export function parseAccountId(idToken: string): string {
  const p = decodeJwtPayload(idToken);
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
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function runLoginFlow(): Promise<StoredTokens> {
  const { verifier, challenge } = generatePkce();
  const state = crypto.randomBytes(16).toString("hex");
  const authorizeUrl = buildAuthorizeUrl({ challenge, state });

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "", `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      if (returnedState !== state || !returnedCode) {
        res.end(
          "<h1>Login failed</h1><p>State mismatch or missing code. You can close this tab.</p>"
        );
        server.close();
        reject(new Error("OAuth state mismatch or missing code"));
        return;
      }
      res.end(
        "<h1>Logged in</h1><p>You can close this tab and return to the terminal.</p>"
      );
      server.close();
      resolve(returnedCode);
    });
    server.on("error", reject);
    server.listen(REDIRECT_PORT, () => {
      console.error(
        `\nTo sign in, open this URL in a browser where you're already signed in to ChatGPT:\n\n${authorizeUrl}\n\nWaiting for the sign-in callback on http://localhost:${REDIRECT_PORT} ...\n`
      );
    });
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
