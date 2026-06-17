import { describe, it, expect } from "vitest";
import {
  buildResponsesRequest,
  parseResponsesStream,
  buildUsageRequest,
} from "../src/client.js";

const auth = { accessToken: "AT", accountId: "acct_1" };

describe("buildResponsesRequest", () => {
  it("sets auth headers and a Responses-API body", () => {
    const req = buildResponsesRequest(auth, { model: "gpt-5.3-codex", instructions: "Be a terse assistant.", input: "hello" });
    expect(req.url).toContain("/backend-api/codex/responses");
    expect(req.headers["Authorization"]).toBe("Bearer AT");
    expect(req.headers["ChatGPT-Account-Id"]).toBe("acct_1");
    const body = JSON.parse(req.body);
    expect(body.model).toBe("gpt-5.3-codex");
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
});

describe("buildUsageRequest", () => {
  it("targets the usage endpoint with auth headers", () => {
    const req = buildUsageRequest(auth);
    expect(req.url).toContain("/backend-api/wham/usage");
    expect(req.headers["Authorization"]).toBe("Bearer AT");
    expect(req.headers["ChatGPT-Account-Id"]).toBe("acct_1");
  });
});
