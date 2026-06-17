import { homedir } from "node:os";
import { join } from "node:path";

// --- OAuth ("Sign in with ChatGPT") -------------------------------------
// Public client_id used by Codex CLI's browser login. [VERIFY-LIVE]
export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OAUTH_SCOPES = "openid profile email offline_access";
export const REDIRECT_PORT = 1455;
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
// Extra authorize params Codex sends; merged into the URL. [VERIFY-LIVE]
export const EXTRA_AUTHORIZE_PARAMS: Record<string, string> = {
  id_token_add_organizations: "true",
  codex_cli_simplified_flow: "true",
};

// --- Backend (undocumented ChatGPT subscription API) --------------------
export const BACKEND_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const BACKEND_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
// Header Codex attaches so the backend accepts the request. [VERIFY-LIVE]
export const BACKEND_ORIGINATOR = "codex_cli_rs";

// --- Models -------------------------------------------------------------
// Models a ChatGPT account can use (from the Codex model cache). There is no
// default — the caller must choose one per request (see the ask_gpt tool).
export const SUPPORTED_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"] as const;

// --- Token storage ------------------------------------------------------
// Override dir with GSS_TOKEN_DIR (used by tests).
export const TOKEN_DIR =
  process.env.GSS_TOKEN_DIR || join(homedir(), ".gpt-subagents-subscription");
export const TOKEN_FILE = join(TOKEN_DIR, "auth.json");

// --- Shared types -------------------------------------------------------
export type StoredTokens = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id: string;
  expires_at: number; // epoch ms
};

export type Auth = { accessToken: string; accountId: string };
