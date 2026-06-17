import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "node:crypto";
import { generatePkce, buildAuthorizeUrl, parseAccountId, runLoginFlow } from "../src/oauth.js";
import { OAUTH_CLIENT_ID, REDIRECT_PORT, REDIRECT_URI } from "../src/config.js";

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

// Valid baseline claims so parseAccountId's lightweight validation passes;
// individual tests override fields to exercise the failure paths.
const validClaims = {
  iss: "https://auth.openai.com",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

function makeIdToken(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({ ...validClaims, ...payload })}.sig`;
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
  it("rejects an id_token whose issuer is not an openai.com host", () => {
    expect(() =>
      parseAccountId(makeIdToken({ iss: "https://evil.example.com", account_id: "a" }))
    ).toThrow(/issuer/i);
  });
  it("rejects a lookalike issuer host (notopenai.com)", () => {
    expect(() =>
      parseAccountId(makeIdToken({ iss: "https://notopenai.com", account_id: "a" }))
    ).toThrow(/issuer/i);
  });
  it("rejects an already-expired id_token", () => {
    expect(() =>
      parseAccountId(
        makeIdToken({ exp: Math.floor(Date.now() / 1000) - 10, account_id: "a" })
      )
    ).toThrow(/expired/i);
  });
  it("rejects an id_token missing exp", () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const noExp = `${b64({ alg: "RS256" })}.${b64({ iss: "https://auth.openai.com", account_id: "a" })}.sig`;
    expect(() => parseAccountId(noExp)).toThrow(/exp/i);
  });
});

describe("runLoginFlow callback server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Start runLoginFlow, capture the `state` it embeds in the authorize URL it
  // prints, and return a promise for the eventual result plus the live state.
  async function startFlow(): Promise<{ result: Promise<unknown>; state: string }> {
    let printed = "";
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      if (typeof msg === "string") printed += msg;
    });
    const result = runLoginFlow();
    // Swallow rejection here so an expected failure doesn't become unhandled;
    // each test still asserts on `result` directly.
    result.catch(() => {});
    // Wait for the server to come up and the authorize URL (with state) to print.
    for (let i = 0; i < 200 && !printed.includes("state="); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const m = printed.match(/state=([a-f0-9]+)/);
    if (!m) throw new Error("authorize URL with state was not printed");
    return { result, state: m[1] };
  }

  it("ignores a wrong-state hit with 400 and keeps listening for the real callback", async () => {
    // Mock the token exchange so the real code path can complete. The callback
    // server itself is driven via rawCallback (node http), so this mock only
    // ever needs to answer the /oauth/token POST.
    const idToken = `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({
        iss: "https://auth.openai.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        account_id: "acct_live",
      })
    ).toString("base64url")}.sig`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "AT",
          refresh_token: "RT",
          id_token: idToken,
          expires_in: 3600,
        }),
        { status: 200 }
      )
    );

    const { result, state } = await startFlow();

    // Stray hit with the wrong state: must be 400 and must NOT settle the flow.
    const stray = await rawCallback(`?state=wrong&code=abc`);
    expect(stray.status).toBe(400);

    // The real callback with the matching state: completes the flow.
    const ok = await rawCallback(`?state=${state}&code=GOODCODE`);
    expect(ok.status).toBe(200);

    const tokens = (await result) as { access_token: string; account_id: string };
    expect(tokens.access_token).toBe("AT");
    expect(tokens.account_id).toBe("acct_live");
  });

  it("rejects terminally when state matches but code is missing", async () => {
    const { result, state } = await startFlow();
    const res = await rawCallback(`?state=${state}&error=access_denied`);
    expect(res.status).toBe(400);
    await expect(result).rejects.toThrow(/access_denied|authorization code/i);
  });
});

// Raw loopback HTTP request that bypasses any global fetch mock, so the
// callback-server tests can drive the server even while fetch is stubbed for the
// token exchange.
function rawCallback(query: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    import("node:http").then((http) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: REDIRECT_PORT,
          path: `/auth/callback${query}`,
          method: "GET",
          // Close the socket immediately so the server can fully shut down and
          // free the fixed port before the next test binds it.
          headers: { Connection: "close" },
          agent: false,
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode || 0, body }));
        }
      );
      req.on("error", reject);
      req.end();
    });
  });
}
