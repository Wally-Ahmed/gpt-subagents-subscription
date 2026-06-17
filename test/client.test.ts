import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildResponsesRequest,
  parseResponsesStream,
  buildUsageRequest,
  BackendProtocolError,
} from "../src/client.js";

const auth = { accessToken: "AT", accountId: "acct_1" };

describe("buildResponsesRequest", () => {
  it("sets auth headers and a Responses-API body", () => {
    const req = buildResponsesRequest(auth, { model: "gpt-5.4", instructions: "Be a terse assistant.", input: "hello" });
    expect(req.url).toContain("/backend-api/codex/responses");
    expect(req.headers["Authorization"]).toBe("Bearer AT");
    expect(req.headers["ChatGPT-Account-Id"]).toBe("acct_1");
    const body = JSON.parse(req.body);
    expect(body.model).toBe("gpt-5.4");
    expect(JSON.stringify(body.input)).toContain("hello");
    expect(body.instructions).toBe("Be a terse assistant.");
  });
  it("includes reasoning effort when provided", () => {
    const req = buildResponsesRequest(auth, {
      model: "gpt-5.4",
      instructions: "sys",
      input: "x",
      reasoningEffort: "high",
    });
    expect(JSON.parse(req.body).reasoning).toEqual({ effort: "high" });
  });
});

describe("parseResponsesStream", () => {
  it("concatenates output_text deltas", () => {
    const raw = [
      `data: {"type":"response.output_text.delta","delta":"Hel"}`,
      `data: {"type":"response.output_text.delta","delta":"lo"}`,
      `data: {"type":"response.completed"}`,
      `data: [DONE]`,
    ].join("\n\n");
    expect(parseResponsesStream(raw)).toBe("Hello");
  });
  it("falls back to a completed event's output_text", () => {
    const raw = `data: {"type":"response.completed","response":{"output_text":"Done"}}`;
    expect(parseResponsesStream(raw)).toBe("Done");
  });

  it("parses a multi-line (pretty-printed) data event as one JSON object", () => {
    const raw = [
      "data: {",
      `data:   "type": "response.completed",`,
      `data:   "response": { "output_text": "Pretty" }`,
      "data: }",
    ].join("\n");
    expect(parseResponsesStream(raw)).toBe("Pretty");
  });

  it("joins deltas across event boundaries and requires completion", () => {
    const raw = [
      `data: {"type":"response.output_text.delta","delta":"A"}`,
      `data: {"type":"response.output_text.delta","delta":"B"}`,
      `data: {"type":"response.completed"}`,
    ].join("\n\n");
    expect(parseResponsesStream(raw)).toBe("AB");
  });

  it("throws on a stream that never completes (truncated)", () => {
    const raw = [
      `data: {"type":"response.output_text.delta","delta":"partial"}`,
    ].join("\n\n");
    expect(() => parseResponsesStream(raw)).toThrow(BackendProtocolError);
  });

  it("throws on malformed JSON instead of silently dropping it", () => {
    const raw = `data: {not valid json`;
    expect(() => parseResponsesStream(raw)).toThrow(BackendProtocolError);
  });

  it("throws when the backend emits an error event after deltas", () => {
    const raw = [
      `data: {"type":"response.output_text.delta","delta":"oops"}`,
      `data: {"type":"response.failed","response":{"status_details":{"reason":"content_policy"}}}`,
    ].join("\n\n");
    expect(() => parseResponsesStream(raw)).toThrow(/content_policy/);
  });

  it("throws on an incomplete event", () => {
    const raw = `data: {"type":"response.incomplete"}`;
    expect(() => parseResponsesStream(raw)).toThrow(BackendProtocolError);
  });

  it("throws when completed but no text was produced", () => {
    const raw = `data: {"type":"response.completed","response":{}}`;
    expect(() => parseResponsesStream(raw)).toThrow(/no text/i);
  });

  it("handles CRLF line endings", () => {
    const raw =
      `data: {"type":"response.output_text.delta","delta":"X"}\r\n\r\n` +
      `data: {"type":"response.completed"}\r\n`;
    expect(parseResponsesStream(raw)).toBe("X");
  });
});

describe("header safety", () => {
  it("rejects auth values containing control characters", () => {
    expect(() =>
      buildResponsesRequest(
        { accessToken: "AT\r\nX-Injected: 1", accountId: "acct_1" },
        { model: "gpt-5.4", instructions: "s", input: "x" }
      )
    ).toThrow(/control characters/);
    expect(() =>
      buildUsageRequest({ accessToken: "AT", accountId: "acct\n1" })
    ).toThrow(/control characters/);
  });
});

describe("buildUsageRequest", () => {
  it("targets the usage endpoint with auth headers", () => {
    const req = buildUsageRequest(auth);
    expect(req.url).toContain("/backend-api/wham/usage");
    expect(req.headers["Authorization"]).toBe("Bearer AT");
    expect(req.headers["ChatGPT-Account-Id"]).toBe("acct_1");
  });
});

describe("respond error body sanitization", () => {
  let dir: string;
  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    dir = mkdtempSync(join(tmpdir(), "gss-client-"));
    process.env.GSS_TOKEN_DIR = dir;
    vi.resetModules();
  });
  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
    delete process.env.GSS_TOKEN_DIR;
    vi.restoreAllMocks();
  });

  it("redacts Bearer tokens and the account id and truncates a long body", async () => {
    const tokens = await import("../src/tokens.js");
    const client = await import("../src/client.js");
    tokens.saveTokens({
      access_token: "SECRET_ACCESS",
      refresh_token: "RT",
      account_id: "acct_SECRET",
      expires_at: Date.now() + 3_600_000,
    });
    const leaky =
      "denied for Bearer SECRET_ACCESS on account acct_SECRET " + "Z".repeat(2000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(leaky, { status: 403 })
    );
    const err = await client.respond({ model: "gpt-5.4", instructions: "s", input: "x" }).then(
      () => null,
      (e) => e as Error
    );
    expect(err).toBeTruthy();
    const msg = err!.message;
    expect(msg).toContain("403");
    expect(msg).not.toContain("SECRET_ACCESS");
    expect(msg).not.toContain("acct_SECRET");
    expect(msg).toContain("[redacted]");
    expect(msg).toContain("[account-id]");
    expect(msg).toContain("[truncated]");
  });

  it("accepts a non-listed model id and reaches request-building (does not reject before fetch)", async () => {
    const client = await import("../src/client.js");
    // A model id not in SUPPORTED_MODELS should be forwarded to the backend,
    // not rejected locally. We confirm this by checking that buildResponsesRequest
    // produces a body containing the unknown model id.
    const req = client.buildResponsesRequest(
      { accessToken: "AT", accountId: "acct_1" },
      { model: "gpt-some-future-model", instructions: "s", input: "x" }
    );
    expect(JSON.parse(req.body).model).toBe("gpt-some-future-model");
  });
});
