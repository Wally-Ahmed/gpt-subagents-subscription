import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { generatePkce, buildAuthorizeUrl, parseAccountId } from "../src/oauth.js";
import { OAUTH_CLIENT_ID, REDIRECT_URI } from "../src/config.js";

describe("generatePkce", () => {
  it("produces a base64url verifier and an S256 challenge of it", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes the required OAuth params", () => {
    const url = new URL(buildAuthorizeUrl({ challenge: "CHAL", state: "STATE" }));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("code_challenge")).toBe("CHAL");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });
});

function makeIdToken(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

describe("parseAccountId", () => {
  it("reads chatgpt_account_id from the openai auth claim", () => {
    const token = makeIdToken({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });
    expect(parseAccountId(token)).toBe("acct_123");
  });
  it("falls back to a top-level account_id", () => {
    expect(parseAccountId(makeIdToken({ account_id: "acct_456" }))).toBe("acct_456");
  });
  it("throws when no account id is present", () => {
    expect(() => parseAccountId(makeIdToken({ sub: "x" }))).toThrow();
  });
});
