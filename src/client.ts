import {
  BACKEND_ORIGINATOR,
  BACKEND_RESPONSES_URL,
  BACKEND_USAGE_URL,
} from "./config.js";
import type { Auth } from "./config.js";
import { getValidAuth } from "./tokens.js";

export type RespondParams = {
  model: string;
  input: string;
  reasoningEffort?: "low" | "medium" | "high";
  instructions?: string;
};

type HttpRequest = { url: string; headers: Record<string, string>; body: string };

function authHeaders(auth: Auth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-Id": auth.accountId,
    originator: BACKEND_ORIGINATOR, // [VERIFY-LIVE]
    "Content-Type": "application/json",
  };
}

export function buildResponsesRequest(auth: Auth, params: RespondParams): HttpRequest {
  const body: Record<string, unknown> = {
    model: params.model,
    input: [{ role: "user", content: [{ type: "input_text", text: params.input }] }],
    stream: true,
    store: false,
  };
  if (params.instructions) body.instructions = params.instructions;
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

// Parse an SSE body: concatenate response.output_text.delta events; fall back to
// a completed event's response.output_text. [VERIFY-LIVE for exact event names]
export function parseResponsesStream(raw: string): string {
  let out = "";
  let fallback = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "[DONE]" || payload === "") continue;
    let evt: any;
    try {
      evt = JSON.parse(payload);
    } catch {
      continue;
    }
    if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
      out += evt.delta;
    } else if (evt.type === "response.completed") {
      const text = evt.response?.output_text;
      if (typeof text === "string") fallback = text;
    }
  }
  return out || fallback;
}

export async function respond(params: RespondParams): Promise<string> {
  const auth = await getValidAuth();
  const req = buildResponsesRequest(auth, params);
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
  if (!res.ok) {
    throw new Error(`Backend error ${res.status}: ${await res.text()}`);
  }
  const text = parseResponsesStream(await res.text());
  if (!text) throw new Error("Backend returned no text output (response format may have changed).");
  return text;
}

export async function getUsage(): Promise<string> {
  const auth = await getValidAuth();
  const req = buildUsageRequest(auth);
  const res = await fetch(req.url, { method: "GET", headers: req.headers });
  if (!res.ok) throw new Error(`Usage check failed ${res.status}: ${await res.text()}`);
  return JSON.stringify(await res.json(), null, 2);
}
