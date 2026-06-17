import {
  BACKEND_ORIGINATOR,
  BACKEND_RESPONSES_URL,
  BACKEND_USAGE_URL,
} from "./config.js";
import type { Auth } from "./config.js";
import { getValidAuth } from "./tokens.js";

export type RespondParams = {
  model: string;
  instructions: string;
  input: string;
  reasoningEffort?: "low" | "medium" | "high";
};

type HttpRequest = { url: string; headers: Record<string, string>; body: string };

// Cap how much of a backend body we ever read into memory / surface in an
// error, so a misbehaving or hostile endpoint can't exhaust memory or flood the
// caller with a huge body.
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB
const MAX_ERROR_BODY_CHARS = 500;

export class BackendProtocolError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BackendProtocolError";
  }
}

// Reject control chars that could smuggle extra HTTP headers. Tokens are
// OAuth-derived and undici already rejects CRLF, but validate defensively
// before we ever build a header from them.
function assertHeaderSafe(name: string, value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`Refusing to send ${name} header containing control characters`);
  }
  return value;
}

function authHeaders(auth: Auth): Record<string, string> {
  return {
    Authorization: `Bearer ${assertHeaderSafe("Authorization", auth.accessToken)}`,
    "ChatGPT-Account-Id": assertHeaderSafe("ChatGPT-Account-Id", auth.accountId),
    originator: BACKEND_ORIGINATOR, // [VERIFY-LIVE]
    "Content-Type": "application/json",
  };
}

// Strip anything that could leak a credential or the account id out of a body
// before it goes into an error message, then truncate.
function sanitizeBody(body: string, auth?: Auth): string {
  let s = body.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
  if (auth?.accountId) {
    s = s.split(auth.accountId).join("[account-id]");
  }
  if (s.length > MAX_ERROR_BODY_CHARS) {
    s = s.slice(0, MAX_ERROR_BODY_CHARS) + "…[truncated]";
  }
  return s;
}

// Read a response body but never more than MAX_BODY_BYTES, so an unbounded
// stream can't be buffered into memory in full.
async function readBodyCapped(res: Response): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total > MAX_BODY_BYTES) {
        out += "…[truncated: response exceeded size limit]";
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

export function buildResponsesRequest(auth: Auth, params: RespondParams): HttpRequest {
  // The Codex backend requires a non-empty `instructions` (system) field; the
  // caller must supply it (no default — the ask_gpt tool makes it required).
  const body: Record<string, unknown> = {
    model: params.model,
    instructions: params.instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: params.input }] }],
    stream: true,
    store: false,
  };
  if (params.reasoningEffort) body.reasoning = { effort: params.reasoningEffort };
  return {
    url: BACKEND_RESPONSES_URL,
    headers: authHeaders(auth),
    body: JSON.stringify(body),
  };
}

export function buildUsageRequest(auth: Auth): {
  url: string;
  headers: Record<string, string>;
} {
  const headers = authHeaders(auth);
  delete (headers as Record<string, string>)["Content-Type"];
  return { url: BACKEND_USAGE_URL, headers };
}

// Split an SSE stream into events on blank-line boundaries and return, per
// event, the concatenated value of its `data:` field(s). A single SSE event may
// span several `data:` lines (e.g. a pretty-printed JSON payload); per RFC they
// are joined with "\n" and parsed as one. Parsing each line independently (the
// previous behavior) dropped any multi-line event.
function splitSseEvents(raw: string): string[] {
  // Normalize CRLF, then split on one-or-more blank lines (event boundary).
  const normalized = raw.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const events: string[] = [];
  for (const block of blocks) {
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      // A single leading space after the colon is part of SSE framing, not data.
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
    if (dataLines.length > 0) events.push(dataLines.join("\n"));
  }
  return events;
}

// Parse an SSE body from the Responses backend. Concatenate
// response.output_text.delta events and require a terminal success event
// (response.completed). Throw a BackendProtocolError on a JSON parse failure, an
// error/failed/incomplete event, or a stream that never completed — so a
// truncated or errored stream is never returned as a partial success.
// [VERIFY-LIVE for exact event names]
export function parseResponsesStream(raw: string): string {
  let out = "";
  let completedText: string | null = null;
  let sawCompleted = false;

  for (const data of splitSseEvents(raw)) {
    if (data === "[DONE]" || data === "") continue;
    let evt: any;
    try {
      evt = JSON.parse(data);
    } catch {
      throw new BackendProtocolError(
        "Failed to parse a server-sent event from the backend (malformed JSON)."
      );
    }
    const type = evt?.type;
    if (type === "response.output_text.delta" && typeof evt.delta === "string") {
      out += evt.delta;
    } else if (type === "response.completed") {
      sawCompleted = true;
      const text = evt.response?.output_text;
      if (typeof text === "string") completedText = text;
    } else if (
      type === "response.failed" ||
      type === "response.incomplete" ||
      type === "error" ||
      type === "response.error"
    ) {
      const reason =
        evt.response?.status_details?.reason ??
        evt.error?.message ??
        evt.message ??
        type;
      throw new BackendProtocolError(`Backend reported a non-success event: ${reason}`);
    }
  }

  if (!sawCompleted) {
    throw new BackendProtocolError(
      "Backend stream ended without a completion event (response may have been truncated)."
    );
  }
  const text = out || completedText || "";
  if (!text) {
    throw new BackendProtocolError("Backend completed but returned no text output.");
  }
  return text;
}

export async function respond(params: RespondParams): Promise<string> {
  const auth = await getValidAuth();
  const req = buildResponsesRequest(auth, params);
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
  if (!res.ok) {
    const body = sanitizeBody(await readBodyCapped(res), auth);
    throw new Error(`Backend error ${res.status}: ${body}`);
  }
  return parseResponsesStream(await readBodyCapped(res));
}

export async function getUsage(): Promise<string> {
  const auth = await getValidAuth();
  const req = buildUsageRequest(auth);
  const res = await fetch(req.url, { method: "GET", headers: req.headers });
  if (!res.ok) {
    const body = sanitizeBody(await readBodyCapped(res), auth);
    throw new Error(`Usage check failed ${res.status}: ${body}`);
  }
  return JSON.stringify(await res.json(), null, 2);
}
